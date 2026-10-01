import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'
import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

function runAgentia(args: string[], timeoutMs = 60_000): string {
  return execFileSync('agentia', args, {encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe']})
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
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

function caseNamesFromRobot(text: string): string[] {
  const names: string[] = []
  const section = text.split('*** Test Cases ***')
  if (section.length < 2) return names
  for (const line of section[1].split('\n')) {
    if (/^\S/.test(line) && line.trim() !== '' && !line.trim().startsWith('#') && !line.trim().startsWith('***')) {
      names.push(line.trim().slice(0, 160))
    }
    if (names.length >= 100) break
  }
  return names
}

function downloadCaseNames(job: string, project: string): {names: string[]; note: string | null} {
  let files: any[] = []
  try {
    files = rowsOf(JSON.parse(runAgentia(['testing', 'job', 'files', job, '-p', project, '--json'])))
  } catch {
    return {names: [], note: `Job ${job} file list unreadable.`}
  }
  const robots = files
    .map((f) => (typeof f === 'string' ? f : str((f as Record<string, unknown>)['path'])))
    .filter((p) => p.toLowerCase().endsWith('.robot'))
    .slice(0, 10)
  if (robots.length === 0) return {names: [], note: `Job ${job} exposes no robot files to read.`}
  const dir = mkdtempSync(join(tmpdir(), 'coverage-'))
  try {
    runAgentia(['testing', 'job', 'download', job, '-p', project,
      ...robots.flatMap((f) => ['-f', f]), '--output-dir', dir, '--json'])
    const names: string[] = []
    for (const f of robots) {
      const base = f.split('/').pop() ?? f
      let text: string | null = null
      for (const candidate of [join(dir, base), join(dir, f)]) {
        try {
          text = readFileSync(candidate, 'utf8')
          break
        } catch {
          continue
        }
      }
      if (text !== null) names.push(...caseNamesFromRobot(text))
    }
    return {names: [...new Set(names)], note: names.length === 0 ? `Job ${job} robot files parsed with zero cases found.` : null}
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
}

export default class TestCoverage extends Command {
  static description =
    'Lexical coverage estimate: story members versus CRT suite names. Heuristic, not execution proof.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --story US-0000024 --job 120561 --crt-project 76303',
    '<%= config.bin %> <%= command.id %> --story US-0000024 --job 120561 --crt-project 76303 --json',
  ]

  static flags = {
    story: Flags.string({char: 's', description: 'User story ID owning the metadata.', required: true}),
    job: Flags.string({char: 'j', description: 'CRT job ID to map suites from. Repeatable.', multiple: true}),
    'crt-project': Flags.string({description: 'CRT project ID used with job IDs.'}),
    json: Flags.boolean({description: 'Machine readable JSON output.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(TestCoverage)
    const story = flags.story as string
    const jobs = (flags.job as string[] | undefined) ?? []
    const crtProject = (flags['crt-project'] as string | undefined) ?? null
    const asJson = (flags.json as boolean) ?? false
    const notes: string[] = []

    let members: string[] = []
    try {
      const steps = rowsOf(JSON.parse(runAgentia(['cicd', 'work', 'deployment-step', 'list', '--user-story', story, '--json'])))
      const recs: string[] = []
      for (const step of steps) {
        const cands: any[] = Array.isArray(step?.members) ? step.members
          : Array.isArray(step?.metadata) ? step.metadata
          : Array.isArray(step?.files) ? step.files : []
        for (const m of cands) {
          if (typeof m === 'string') recs.push(m)
          else if (typeof m === 'object' && m !== null) {
            const n = str((m as Record<string, unknown>)['metadataName'] || (m as Record<string, unknown>)['member'] || (m as Record<string, unknown>)['name'])
            if (n !== '') recs.push(n)
          }
        }
      }
      members = [...new Set(recs)]
    } catch {
      notes.push('Deployment steps unreadable. Coverage computed against an empty member set.')
      members = []
    }

    const suites: string[] = []
    if (jobs.length > 0 && crtProject) {
      for (const job of jobs) {
        try {
          const found = downloadCaseNames(job, crtProject)
          suites.push(...found.names)
          if (found.note) notes.push(found.note)
        } catch {
          notes.push(`Job ${job} files unreadable. Skipped from suite mapping.`)
        }
      }
    } else if (jobs.length > 0) {
      notes.push('Jobs given without --crt-project, skipping suite mapping.')
    }
    const uniqueSuites = [...new Set(suites)]

    const covered: string[] = []
    const gaps: string[] = []
    for (const member of members) {
      const low = member.toLowerCase()
      const hit = uniqueSuites.some((s) => {
        const sl = s.toLowerCase()
        return sl.includes(low) || low.includes(sl) || low.split(/[^a-z0-9]+/).some((tok) => tok.length > 3 && sl.includes(tok))
      })
      if (hit) covered.push(member)
      else gaps.push(member)
    }
    const pct = members.length === 0 ? 100 : Math.round((covered.length / members.length) * 100)
    const payload = {
      status: 'estimated',
      story,
      memberCount: members.length,
      coveredCount: covered.length,
      coveragePct: pct,
      covered,
      gaps,
      suites: uniqueSuites.slice(0, 30),
      method: 'Lexical name matching between story members and suite names. Estimate only, not execution proof.',
      notes,
    }
    if (asJson) {
      this.log(JSON.stringify(payload, null, 2))
    } else {
      this.log(`Coverage estimate for ${story}: ${pct}% (${covered.length}/${members.length} members named in suites).`)
      for (const g of gaps.slice(0, 15)) this.log(`  gap: ${g}`)
      this.log('Lexical estimate only, not execution proof.')
    }
  }
}
