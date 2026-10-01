import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'

function runAgentia(args: string[], timeoutMs = 60_000): string {
  return execFileSync('agentia', args, {encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe']})
}

function rowsOf(parsed: any): any[] {
  if (!parsed || typeof parsed !== 'object') return []
  const r = parsed?.result ?? parsed
  if (Array.isArray(r)) return r
  for (const key of ['data', 'builds', 'jobs', 'runs']) {
    if (Array.isArray((r as Record<string, unknown>)?.[key])) return (r as Record<string, unknown>)[key] as any[]
  }
  return []
}

function bucket(status: string): 'pass' | 'fail' | 'other' {
  if (/^(succeeded|success|passed|pass|completed)$/i.test(status)) return 'pass'
  if (/^(failed|failure|error|errored)$/i.test(status)) return 'fail'
  return 'other'
}

export default class TestFlaky extends Command {
  static description =
    'Detect flaky tests from build history flip flops. Heuristic verdicts, stated openly.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --job 120561 --project 76303',
    '<%= config.bin %> <%= command.id %> --job 120561 --project 76303 --builds 20 --json',
  ]

  static flags = {
    job: Flags.string({char: 'j', description: 'CRT job or test ID.', required: true}),
    project: Flags.string({char: 'p', description: 'CRT project ID.', required: true}),
    builds: Flags.integer({char: 'n', description: 'Recent builds analyzed.', default: 20}),
    json: Flags.boolean({description: 'Machine readable JSON output.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(TestFlaky)
    const job = flags.job as string
    const project = flags.project as string
    const count = Math.max(2, Math.min(100, (flags.builds as number) ?? 20))
    const asJson = (flags.json as boolean) ?? false

    let runs: any[] = []
    try {
      runs = rowsOf(JSON.parse(runAgentia(['testing', 'build', 'search', '-p', project, '-j', job, '--page-size', String(count), '--json'])))
    } catch (error: any) {
      const detail = `Build history unreadable: ${(error?.message ?? String(error)).split('\n')[0]}`
      if (asJson) this.log(JSON.stringify({status: 'error', job, project, detail}, null, 2))
      else this.log(detail)
      this.exit(1)
    }

    const seq = runs
      .map((r) => {
        const raw = typeof r?.status === 'string' ? r.status
          : typeof r?.categories?.state === 'string' ? r.categories.state : 'unknown'
        const id = r?.id ?? r?.buildId ?? r?.buildNumber ?? '?'
        return {id: String(id), status: raw, bucket: bucket(raw)}
      })
      .filter((s) => s.bucket !== 'other')
      .reverse()
    const others = runs.length - seq.length

    let verdict = 'insufficient-data'
    let transitions = 0
    for (let i = 1; i < seq.length; i += 1) {
      if (seq[i].bucket !== seq[i - 1].bucket) transitions += 1
    }
    const passes = seq.filter((s) => s.bucket === 'pass').length
    const fails = seq.filter((s) => s.bucket === 'fail').length
    if (seq.length < 2) {
      verdict = 'insufficient-data'
    } else if (fails === 0) {
      verdict = 'stable-green'
    } else if (passes === 0) {
      verdict = 'stable-red'
    } else if (transitions >= 2) {
      verdict = 'flaky'
    } else {
      verdict = 'mostly-stable'
    }
    const score = seq.length < 2 ? 0 : Math.round((transitions / (seq.length - 1)) * 100)
    const payload = {
      status: verdict,
      job,
      project,
      runsAnalyzed: seq.length,
      passes,
      fails,
      transitions,
      flakinessScore: `${score} (flip flop rate across scored runs, heuristic)`,
      excludedNonTerminal: others,
      sequence: seq.map((s) => `${s.id}=${s.status}`),
      note: 'Heuristic over terminal states only. Aborts plus timeouts are excluded, never counted as passes or failures.',
    }
    if (asJson) {
      this.log(JSON.stringify(payload, null, 2))
    } else {
      this.log(`Flakiness for job ${job}: ${verdict.toUpperCase()} across ${seq.length} scored runs (${passes} pass, ${fails} fail, ${transitions} flip flops).`)
      if (verdict === 'flaky') this.log('Recommendation: quarantine the flipping cases and rerun them in isolation before trusting this suite in gates.');
      else if (verdict === 'stable-red') this.log('Recommendation: fix the suite before using it in any gate.');
      else if (verdict === 'insufficient-data') this.log('Recommendation: accumulate at least 2 terminal runs before judging stability.');
    }
  }
}
