import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'
import {writeFileSync} from 'node:fs'
import {resolve} from 'node:path'

const AI_TIMEOUT_MS = 180_000

function runAgentia(args: string[], timeoutMs = 60_000): string {
  return execFileSync('agentia', args, {encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe']})
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}

function findAgentText(node: unknown, depth = 0): string | null {
  if (node == null || depth > 3) return null
  if (typeof node === 'string') return node.trim() !== '' ? node.trim() : null
  if (typeof node === 'object' && !Array.isArray(node)) {
    const obj = node as Record<string, unknown>
    for (const key of ['response', 'text', 'answer', 'message', 'content', 'output', 'summary']) {
      const v = obj[key]
      if (typeof v === 'string' && v.trim() !== '') return v.trim()
    }
    if ('result' in obj) return findAgentText(obj['result'], depth + 1)
  }
  return null
}

function extractRobot(text: string): string {
  const start = text.indexOf('*** Settings ***')
  if (start >= 0) return text.slice(start).trim() + '\n'
  const fenced = /```(?:robot|robotframework)?\n([\s\S]*?)```/.exec(text)
  if (fenced) return fenced[1].trim() + '\n'
  return text.trim() + '\n'
}

export default class TestGen extends Command {
  static description =
    'Generate a Robot Framework skeleton for a story with the test agent. Review before importing.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --story US-0000024',
    '<%= config.bin %> <%= command.id %> --story US-0000024 --output ./smoke.robot --json',
  ]

  static flags = {
    story: Flags.string({char: 's', description: 'User story ID or name driving the skeleton.', required: true}),
    output: Flags.string({char: 'o', description: 'File path for the generated skeleton.'}),
    json: Flags.boolean({description: 'Machine readable JSON output.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(TestGen)
    const story = flags.story as string
    const output = resolve(process.cwd(), (flags.output as string)
      ?? `./generated-${story.replace(/[^a-zA-Z0-9]+/g, '-')}.robot`)
    const asJson = (flags.json as boolean) ?? false

    let context = `Story ${story}.`
    try {
      const parsed: any = JSON.parse(runAgentia(['cicd', 'work', 'get', story, '--json']))
      const rec = parsed?.result ?? parsed
      context = `Story ${str(rec?.name) || story}: ${str(rec?.title)}. ` +
        `Requirements: ${str(rec?.functionalRequirements).slice(0, 800) || 'none recorded'}. ` +
        `Status: ${str(rec?.status) || 'unknown'}.`
    } catch {
      context = `Story ${story} (details unreadable, generating from the ID alone).`
    }

    const prompt =
      `Write a Robot Framework smoke test skeleton for this Salesforce story. ` +
      `Use "*** Settings ***" with Library QForce, Suite Setup opening a browser and Suite Teardown closing browsers. ` +
      `Then a "*** Test Cases ***" section with exactly 2 passing smoke cases using only Log and Sleep keywords, no real assertions. ` +
      `Return only the .robot file content, no explanations. ${context}`
    let skeleton: string | null = null
    try {
      const out = runAgentia(['ai', 'agent', 'ask', '-p', prompt, '--agent', 'test', '--json'], AI_TIMEOUT_MS)
      let parsed: unknown
      try {
        parsed = JSON.parse(out)
      } catch {
        parsed = out
      }
      const text = findAgentText(parsed)
      skeleton = text ? extractRobot(text) : null
    } catch {
      skeleton = null
    }

    if (!skeleton) {
      const detail = 'Test generation failed. AI agent unreachable or returned nothing. Nothing was written.'
      if (asJson) this.log(JSON.stringify({status: 'error', story, detail}, null, 2))
      else this.log(detail)
      this.exit(1)
    }

    writeFileSync(output, skeleton as string, 'utf8')
    const payload = {
      status: 'generated',
      story,
      file: output,
      chars: (skeleton as string).length,
      note: 'Skeleton only. Review every line, then import it into the CRT job through QEditor before running.',
    }
    if (asJson) {
      this.log(JSON.stringify(payload, null, 2))
    } else {
      this.log(`Skeleton for ${story} written to ${output} (${payload.chars} chars).`)
      this.log('Review every line, then import it into the CRT job through QEditor before running.')
    }
  }
}
