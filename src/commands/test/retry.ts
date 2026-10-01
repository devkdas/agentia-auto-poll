import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, writeFileSync} from 'node:fs'
import {join, resolve} from 'node:path'

const TERMINAL_RE = /^(completed|complete|success|succeeded|successful|passed|pass|failed|failure|error|errored|cancelled|canceled|aborted|timeout|timed.?out)/i
const RUNNING_RE = /(progress|running|queued|pending|started|executing|in.?progress|waiting)/i

function runAgentia(args: string[], timeoutMs = 60_000): string {
  return execFileSync('agentia', args, {encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe']})
}

function findStatus(node: unknown, depth = 0): string | null {
  if (node == null || depth > 4) return null
  if (typeof node === 'string') {
    const v = node.trim()
    if (TERMINAL_RE.test(v) || RUNNING_RE.test(v)) return v
    return null
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findStatus(item, depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>
    for (const [key, value] of Object.entries(obj)) {
      if (/^(status|state|testresult)$/i.test(key) && typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    for (const value of Object.values(obj)) {
      const hit = findStatus(value, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

function findId(node: unknown, depth = 0): string | null {
  if (node == null || depth > 4) return null
  if (typeof node === 'object' && !Array.isArray(node)) {
    const obj = node as Record<string, unknown>
    for (const key of ['executionId', 'execution_id', 'buildId', 'build_id', 'buildID', 'runId', 'run_id', 'id']) {
      const v = obj[key]
      if (typeof v === 'string' || typeof v === 'number') {
        const s = String(v).trim()
        if (s !== '' && s !== '0') return s
      }
    }
    for (const value of Object.values(obj)) {
      const hit = findId(value, depth + 1)
      if (hit) return hit
    }
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findId(item, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

export default class TestRetry extends Command {
  static description =
    'Re-run only the failed tests from a build instead of the whole suite.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --job 120561 --project 76303',
    '<%= config.bin %> <%= command.id %> --job 120561 --project 76303 --execution 5875729 --json',
  ]

  static flags = {
    job: Flags.string({char: 'j', description: 'CRT job or test ID.', required: true}),
    project: Flags.string({char: 'p', description: 'CRT project ID.', required: true}),
    execution: Flags.string({char: 'e', description: 'Build ID to rerun failures from. Defaults to the latest failed run.'}),
    'output-dir': Flags.string({char: 'o', description: 'Directory for logs and result JSON.', default: './test-results'}),
    'interval-sec': Flags.integer({description: 'Seconds between status polls.', default: 15}),
    'timeout-sec': Flags.integer({description: 'Max seconds to poll before giving up.', default: 1800}),
    json: Flags.boolean({description: 'Machine readable JSON summary.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(TestRetry)
    const job = flags.job as string
    const project = flags.project as string
    const execution = (flags.execution as string | undefined) ?? null
    const outDir = resolve(process.cwd(), (flags['output-dir'] as string) ?? './test-results')
    const intervalSec = Math.max(5, (flags['interval-sec'] as number) ?? 15)
    const timeoutSec = Math.max(30, (flags['timeout-sec'] as number) ?? 1800)
    const asJson = (flags.json as boolean) ?? false

    try {
      const gate = JSON.parse(runAgentia(['auth', 'get', '--crt', '--json']))
      const creds: any[] = gate?.result?.credentials ?? []
      const crt = creds.find((c) => c?.type === 'crt') ?? gate?.result ?? gate
      if (!crt?.ready) {
        const detail = 'CRT is not ready. Fix until auth reports ready:true before retrying.'
        if (asJson) this.log(JSON.stringify({status: 'blocked', job, project, detail}, null, 2))
        else this.log(detail)
        this.exit(1)
      }
    } catch {
      const detail = 'CRT readiness unreadable. Fix authentication before retrying.'
      if (asJson) this.log(JSON.stringify({status: 'blocked', job, project, detail}, null, 2))
      else this.log(detail)
      this.exit(1)
    }

    const runArgs = ['testing', 'build', 'run', job, '-p', project, '--json']
    if (execution) runArgs.push('--rerun-failed', execution)
    else runArgs.push('--rerun-failed-from-latest')

    let runOut: string
    try {
      runOut = runAgentia(runArgs)
    } catch (error: any) {
      const detail = `Retry trigger failed: ${(error?.message ?? String(error)).split('\n')[0]}`
      if (asJson) this.log(JSON.stringify({status: 'error', job, project, detail}, null, 2))
      else this.log(detail)
      this.exit(1)
    }

    let runParsed: any = null
    try {
      runParsed = JSON.parse(runOut as string)
    } catch {
      if (asJson) this.log(JSON.stringify({status: 'error', job, project, detail: 'Trigger returned non JSON output.'}, null, 2))
      else this.log('Trigger returned non JSON output.')
      this.exit(1)
    }

    const executionId = findId(runParsed) ?? findId((runParsed as any)?.result)
    if (!executionId) {
      const detail = 'Trigger succeeded but no execution ID was found in the JSON response.'
      if (asJson) this.log(JSON.stringify({status: 'error', job, project, detail}, null, 2))
      else this.log(detail)
      this.exit(1)
    }

    mkdirSync(outDir, {recursive: true})
    const deadline = Date.now() + timeoutSec * 1000
    let lastStatus = 'unknown'
    while (Date.now() < deadline) {
      let pollOut: string
      try {
        pollOut = runAgentia(['testing', 'build', 'get', executionId, '-p', project, '-j', job, '--json'])
      } catch (error: any) {
        if (!asJson) this.log(`Poll hit an error, retrying: ${(error?.message ?? String(error)).split('\n')[0]}`)
        await sleep(intervalSec * 1000)
        continue
      }
      try {
        const parsed = JSON.parse(pollOut)
        const found = findStatus(parsed) ?? findStatus((parsed as any)?.result)
        if (found) lastStatus = found
        if (found && TERMINAL_RE.test(found)) break
      } catch {
        await sleep(intervalSec * 1000)
        continue
      }
      if (!asJson) this.log(`Retry build ${executionId} status: ${lastStatus}. Waiting ${intervalSec}s.`)
      await sleep(intervalSec * 1000)
    }

    const terminal = TERMINAL_RE.test(lastStatus)
    const logFile = join(outDir, `retry-${executionId}.log`)
    const resultFile = join(outDir, `retry-${executionId}.json`)
    let logsSaved = false
    let resultSaved = false
    try {
      runAgentia(['testing', 'build', 'logs', executionId, '-p', project, '-j', job, '-o', logFile])
      logsSaved = existsSync(logFile)
    } catch {
      logsSaved = false
    }
    try {
      const full = runAgentia(['testing', 'build', 'get', executionId, '-p', project, '-j', job, '--full', '--json'])
      writeFileSync(resultFile, full, 'utf8')
      resultSaved = true
    } catch {
      resultSaved = false
    }

    const summary = {
      status: terminal ? lastStatus : 'timeout',
      job,
      project,
      retriedFrom: execution ?? 'latest-failed',
      executionId,
      terminal,
      logsSaved,
      logFile: logsSaved ? logFile : null,
      resultSaved,
      resultFile: resultSaved ? resultFile : null,
    }
    if (asJson) {
      this.log(JSON.stringify(summary, null, 2))
    } else {
      this.log(`Retry build ${executionId} finished with status ${summary.status} (retried from ${summary.retriedFrom}).`)
      this.log(`Logs: ${logsSaved ? logFile : 'not saved'}. Result: ${resultSaved ? resultFile : 'not saved'}.`)
    }
    if (!terminal) this.exit(1)
  }
}
