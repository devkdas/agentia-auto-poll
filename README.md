# Agentia Auto Poll

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node 18+](https://img.shields.io/badge/node-%3E%3D18-blue.svg)](package.json)
[![Agentia 0.122](https://img.shields.io/badge/agentia-0.122.0--alpha.1-blue.svg)](https://developer.copado.com/docs)

**Auto Poll** makes CRT test runs truly headless. It triggers in JSON mode,
polls to a terminal state, persists logs plus full results, and optionally
notifies Slack. Built around the documented limits instead of against them.

No babysitting required. Built for the **Agentia Headless Virtual
Hackathon** as an oclif plugin on top of the public `agentia` CLI.

---

## Table of Contents

- [The Problem](#the-problem)
- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Live Demo Workflow](#live-demo-workflow)
- [Command Reference](#command-reference)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [How It Works](#how-it-works)
- [Security](#security)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Hackathon Fit](#hackathon-fit)
- [License](#license)

---

## The Problem

Datatable driven test runs resist automation. The docs confirm that
`--stream-logs` and `--watch` are human terminal features unavailable with
`--json`, and a `--datatable` run cannot combine with `--wait-for-result`,
`--stream-logs`, `--save-artifacts` or `--xunit`. Build search is paged and
needs project plus job, while logs and artifacts are never written unless
explicit paths are passed. Scripts either block, lose results, or poll by
hand.

## Features

- **JSON first run** — triggers with `--json` and parses the execution ID
  flexibly across response shapes.
- **Patient polling** — polls `testing build get` with configurable
  interval plus timeout until a terminal status, detecting both success
  and failure vocabularies.
- **Honest precheck** — refuses to spend a run while CRT is not ready,
  naming the exact missing fields.
- **Persisted evidence** — saves the log file plus the full `--full`
  result JSON to an explicit output directory.
- **Datatable passthrough** — repeatable `--datatable TABLE:sets`
  selections forwarded to the real run command.
- **Slack summary** — optional webhook post with build, job and status.
- **Opt-in AI summary** — `--ai-summary` asks the test agent to
  summarize failures in two sentences plus one fix, routed into terminal,
  JSON and Slack output. Off by default so runs stay deterministic and
  cost free. Needs the AI domain configured (otherwise the summary stays
  null without failing the run), and AI failures never fail the run.
- **Zero private imports** — only shells out to public `agentia`
  commands.

## Installation

### Prerequisites

- Node 18 or newer.
- Agentia CLI beta: `npm install -g @copado/agentia-cli@beta`
- CRT `ready:true` from `agentia auth get --crt --json` for live runs.

### Install from source

```sh
git clone https://github.com/devkdas/agentia-auto-poll.git
cd agentia-auto-poll
npm install
npm run build
agentia plugins link .
```

Re-run `npm run build` after every change to the TypeScript files.

## Quick Start

### 1. Run a job headlessly

```sh
agentia test auto --job 120561 --project 76303
```

### 2. Add a datatable plus JSON summary

```sh
agentia test auto --job 120561 --project 76303 --datatable 12:1,2-4 --output-dir ./test-results --json
```

### 3. Tune for CI plus Slack

```sh
agentia test auto --job 120561 --project 76303 --interval-sec 15 --timeout-sec 600 --slack-webhook https://hooks.slack.com/xxx
```

### 4. Generate a skeleton from a story

```sh
agentia test gen --story US-0000024 --output ./smoke.robot --json
```

## Live Demo Workflow

Verified live against real CRT (project 76303, job CLI-Target-Job):

```text
1. agentia test auto --job 120561 --project 76303 --json (empty job)
   -> status blocked is never spent; honest refusal naming missing readiness
   (first run showed an empty job aborting, which the plugin surfaced exactly)
2. Add one smoke test case to the job in the CRT portal
3. agentia test auto --job 120561 --project 76303 --output-dir ./test-results --json
   -> status succeeded, execution 5874554, terminal true,
      log file plus result JSON saved to disk
```

## Command Reference

### `agentia test auto`

| Flag | Description |
|---|---|
| `-j, --job <id>` | CRT job or test ID (required) |
| `-p, --project <id>` | CRT project ID (required) |
| `-d, --datatable <sel>` | `TABLE_ID:sets` selection, repeatable |
| `-o, --output-dir <dir>` | Log plus result directory (default `./test-results`) |
| `--interval-sec <n>` | Seconds between polls, minimum 5 (default 15) |
| `--timeout-sec <n>` | Max polling seconds, minimum 30 (default 1800) |
| `--slack-webhook <url>` | Incoming webhook for the summary, optional |
| `--ai-summary` | Ask the test agent to summarize failures, off by default |
| `--json` | Machine readable summary |

The summary carries `status`, `job`, `project`, `executionId`,
`terminal`, `logsSaved`, `logFile`, `resultSaved` and `resultFile`.
Timeouts report `status: timeout` honestly instead of pretending success.

### `agentia test gen`

| Flag | Description |
|---|---|
| `-s, --story <id>` | User story driving the skeleton (required) |
| `-o, --output <path>` | Skeleton file path (defaults into cwd) |
| `--json` | Machine readable JSON output |

Generates a passing only Robot skeleton from live story context through
the test agent. Skeleton only: review every line, then import it into
the CRT job through QEditor before running. Fails honestly with nothing
written when the agent is unreachable.

### `agentia test coverage`

| Flag | Description |
|---|---|
| `-s, --story <id>` | User story owning the metadata (required) |
| `-j, --job <id>` | CRT job ID to map case names from, repeatable |
| `--crt-project <id>` | CRT project ID used with job IDs |
| `--json` | Machine readable JSON output |

### `agentia test retry`

| Flag | Description |
|---|---|
| `-j, --job <id>` | CRT job or test ID (required) |
| `-p, --project <id>` | CRT project ID (required) |
| `-e, --execution <id>` | Build ID to rerun failures from (defaults to latest failed run) |
| `-o, --output-dir <dir>` | Log plus result directory (default `./test-results`) |
| `--interval-sec <n>` | Seconds between polls (default 15, minimum 5) |
| `--timeout-sec <n>` | Max polling seconds (default 1800, minimum 30) |
| `--json` | Machine readable JSON summary |

Re-runs only failed tests through the rerun failed flags, then polls
plus persists exactly like a normal run. The summary names the source
build in `retriedFrom` for traceability.

### `agentia test flaky`

| Flag | Description |
|---|---|
| `-j, --job <id>` | CRT job or test ID (required) |
| `-p, --project <id>` | CRT project ID (required) |
| `-n, --builds <n>` | Recent builds analyzed (default 20, 2 to 100) |
| `--json` | Machine readable JSON output |

Scores flip flop rate across terminal states into stable green, stable
red, flaky, mostly stable or insufficient data verdicts. Aborts plus
timeouts are excluded, never counted either way. Heuristic, stated
openly on every output.

Downloads the job's robot files, parses real test case names, and
lexically matches them against story deployment members into covered
versus gap lists with a percentage. Estimate only, never execution
proof. Downloads land in temp space and are removed after parsing.

## Configuration

All behavior flows through flags. The webhook stays a flag so it never
lands in code. Polling bounds keep CI runners safe by default.

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| `blocked`, CRT not ready | PAK, domain or org missing | Complete CRT setup until `ready:true` |
| Run aborts in 0 seconds | Job has no test suites or cases | Add at least one case in the CRT portal |
| `timeout` status | Job outlived the polling window | Raise `--timeout-sec` and rerun |
| Missing flags error | `--job` or `--project` omitted | Both are required, see `--help` |
| ESM auto-transpile warning | Linked ESM plugin notice | Benign, compiled output is used |

## How It Works

```text
agentia test auto
  -> auth get --crt --json (refuse honestly unless ready:true)
  -> testing build run <job> -p <project> [--datatable] --json
  -> testing build get <exec> -p -j --json (poll to terminal)
  -> testing build logs <exec> -p -j -o <file>
  -> testing build get <exec> -p -j --full --json (saved to file)
  -> optional Slack webhook post
  -> human or JSON summary
```

## Security

Secrets stay in flags and the keychain, never in files. Result JSON from
the server can contain org secrets, so keep output directories local and
out of public repos.

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript on Node 18+ |
| CLI Framework | oclif v4 (ESM, matching the host CLI) |
| Runtime calls | `node:child_process` to public `agentia` commands |
| HTTP | Global `fetch` for the optional Slack post, no extra deps |

## Architecture

```text
CI / Developer / Agent
       |
agentia test auto --job --project [--datatable]
       |
Auto Poll (this plugin)
  |- readiness gate -> auth get --crt --json
  |- trigger        -> testing build run --json
  |- poller         -> testing build get loop
  |- evidence       -> build logs -o, build get --full
  |- notify         -> Slack webhook (optional)
       |
Summary JSON plus persisted files
```

## Hackathon Fit

Automates a repetitive workflow end to end, enables notifications,
reporting and event driven follow ups, and connects the CLI with
collaboration tooling. Turns four documented limits into one smooth
command.

## License

MIT License — see [LICENSE](LICENSE) for details.
