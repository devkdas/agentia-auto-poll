# Agentia Auto Poll

Headless CRT datatable runs with polling, persisted reports and optional Slack
notifications for Agentia CLI.

Built for the Agentia Headless Virtual Hackathon as an oclif plugin on top of
the public `agentia` CLI. It works around documented limits: `--stream-logs`
and `--watch` are human terminal features unavailable with `--json`, and a
`--datatable` run cannot combine with `--wait-for-result`, `--stream-logs`,
`--save-artifacts` or `--xunit`. So it runs with `--json`, polls
`testing build get`, then fetches `testing build logs` to explicit paths.

## Install

```sh
npm install
npm run build
agentia plugins link .
```

## Usage

```sh
agentia test auto --job 120561 --project 76303
agentia test auto --job 120561 --project 76303 --datatable 12:1,2-4
agentia test auto --job 120561 --project 76303 --output-dir ./test-results --json
agentia test auto --job 120561 --project 76303 --slack-webhook https://hooks.slack.com/xxx
```

Requires CRT `ready:true` from `agentia auth get --crt --json` before running.
Use `--interval-sec` and `--timeout-sec` to tune polling for CI.

## License

MIT
