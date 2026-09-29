import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, writeFileSync} from 'node:fs'
import {join, resolve} from 'node:path'

const TERMINAL_RE = /^(completed|complete|success|succeeded|successful|passed|pass|failed|failure|error|errored|cancelled|canceled|aborted|timeout|timed.?out)/i
const RUNNING_RE = /(progress|running|queued|pending|started|executing|in.?progress|waiting)/i
const STATUS_KEYS = new Set(['status', 'state', 'testresult', 'test_result', 'result', 'buildstatus', 'build_status', 'runstatus', 'run_status'])

function runAgentia(args: string[]): string {
  return execFileSync('agentia', args, {encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe']})
}

function crtReady(): {ready: boolean; missing: string[]} {
  try {
    const parsed: any = JSON.parse(runAgentia(['auth', 'get', '--crt', '--json']))
    const creds: any[] = parsed?.result?.credentials ?? []
    const crt = creds.find((c) => c?.type === 'crt') ?? parsed?.result ?? parsed
    return {ready: Boolean(crt?.ready), missing: Array.isArray(crt?.missing) ? crt.missing : []}
  } catch {
    return {ready: false, missing: []}
  }
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
      if (STATUS_KEYS.has(key.toLowerCase()) && typeof value === 'string' && value.trim() !== '') return value.trim()
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

export default class TestAuto extends Command {
  static description =
    'Run a CRT job headlessly with JSON polling, persisted logs and optional Slack notification.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --job 120561 --project 76303',
    '<%= config.bin %> <%= command.id %> --job 120561 --project 76303 --datatable 12:1,2-4',
    '<%= config.bin %> <%= command.id %> --job 120561 --project 76303 --output-dir ./test-results --json',
  ]

  static flags = {
    job: Flags.string({char: 'j', description: 'CRT job or test ID.', required: true}),
    project: Flags.string({char: 'p', description: 'CRT project ID.', required: true}),
    datatable: Flags.string({
      char: 'd',
      description: 'Data table selection as TABLE_ID:1,2-4. Repeatable.',
      multiple: true,
    }),
    'output-dir': Flags.string({char: 'o', description: 'Directory for logs and result JSON.', default: './test-results'}),
    'interval-sec': Flags.integer({description: 'Seconds between status polls.', default: 15}),
    'timeout-sec': Flags.integer({description: 'Max seconds to poll before giving up.', default: 1800}),
    'slack-webhook': Flags.string({description: 'Slack incoming webhook URL for the summary. Optional.'}),
    json: Flags.boolean({description: 'Machine readable JSON summary.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(TestAuto)
    const job = flags.job as string
    const project = flags.project as string
    const datatables = (flags.datatable as string[] | undefined) ?? []
    const outDir = resolve(process.cwd(), (flags['output-dir'] as string) ?? './test-results')
    const intervalSec = Math.max(5, (flags['interval-sec'] as number) ?? 15)
    const timeoutSec = Math.max(30, (flags['timeout-sec'] as number) ?? 1800)
    const webhook = (flags['slack-webhook'] as string | undefined) ?? null
    const asJson = (flags.json as boolean) ?? false

    const gate = crtReady()
    if (!gate.ready) {
      const detail =
        `CRT is not ready. Fix until agentia auth get --crt --json reports ready:true.` +
        (gate.missing.length > 0 ? ` Missing: ${gate.missing.join(', ')}.` : '')
      if (asJson) this.log(JSON.stringify({status: 'blocked', job, project, detail}, null, 2))
      else this.log(detail)
      this.exit(1)
    }

    const runArgs = ['testing', 'build', 'run', job, '-p', project, '--json']
    for (const table of datatables) runArgs.push('--datatable', table)

    let runOut: string
    try {
      runOut = runAgentia(runArgs)
    } catch (error: any) {
      const detail = `Trigger failed: ${(error?.message ?? String(error)).split('\n')[0]}`
      if (asJson) this.log(JSON.stringify({status: 'error', job, project, detail}, null, 2))
      else this.log(detail)
      this.exit(1)
    }

    let runParsed: any = null
    try {
      runParsed = JSON.parse(runOut as string)
    } catch {
      if (asJson) this.log(JSON.stringify({status: 'error', job, project, detail: 'Trigger returned non JSON output.'}, null, 2))
      else this.log('Trigger returned non JSON output. Raw output:\n' + runOut)
      this.exit(1)
    }

    const executionId = findId(runParsed) ?? findId((runParsed as any)?.result)
    if (!executionId) {
      const detail = 'Trigger succeeded but no execution ID was found in the JSON response.'
      if (asJson) this.log(JSON.stringify({status: 'error', job, project, detail, raw: runParsed}, null, 2))
      else this.log(detail)
      this.exit(1)
    }

    mkdirSync(outDir, {recursive: true})
    const deadline = Date.now() + timeoutSec * 1000
    let lastStatus = 'unknown'
    let finalPayload: any = null

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
        finalPayload = JSON.parse(pollOut)
      } catch {
        await sleep(intervalSec * 1000)
        continue
      }
      const found = findStatus(finalPayload) ?? findStatus((finalPayload as any)?.result)
      if (found) lastStatus = found
      if (found && TERMINAL_RE.test(found)) break
      if (!asJson) this.log(`Build ${executionId} status: ${lastStatus}. Waiting ${intervalSec}s.`)
      await sleep(intervalSec * 1000)
    }

    const terminal = TERMINAL_RE.test(lastStatus)
    const logFile = join(outDir, `build-${executionId}.log`)
    const resultFile = join(outDir, `build-${executionId}.json`)
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
      try {
        finalPayload = JSON.parse(full)
      } catch {
        /* keep polling payload */
      }
    } catch {
      resultSaved = false
    }

    const summary = {
      status: terminal ? lastStatus : 'timeout',
      job,
      project,
      executionId,
      terminal,
      logsSaved,
      logFile: logsSaved ? logFile : null,
      resultSaved,
      resultFile: resultSaved ? resultFile : null,
    }

    if (webhook) {
      try {
        await fetch(webhook, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            text: `CRT build ${executionId} (job ${job}) finished with status ${summary.status}. Logs saved: ${logsSaved}.`,
          }),
        })
      } catch {
        if (!asJson) this.log('Slack notification failed. Report files are still saved locally.');
      }
    }

    if (asJson) {
      this.log(JSON.stringify(summary, null, 2))
    } else {
      this.log(`Build ${executionId} finished with status ${summary.status}.`)
      this.log(`Logs: ${logsSaved ? logFile : 'not saved'}. Result: ${resultSaved ? resultFile : 'not saved'}.`)
    }

    if (!terminal) this.exit(1)
  }
}
