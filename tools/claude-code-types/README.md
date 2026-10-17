# Claude Code types for the plugin

A snapshot of the declarations Claude Code writes into `claude-plugin/.claude-plugin/types/` (gitignored) when it
loads the plugin with `--plugin-dir` in an interactive session; it writes them nowhere in `-p`, SDK or CI runs.
`npm run typecheck:plugin` checks the plugin against this copy, the version `CLAUDE_CODE_VERSION` pins in
`.github/workflows/ci.yml`.

To move to a newer Claude Code: run `claude --plugin-dir claude-plugin` once, check the first line of
`claude-plugin/.claude-plugin/types/claude-code/index.d.ts` names the new version, then copy `claude-code/` and
`claude-code-tools/` here (not `claude-code-mcp/`, which lists your own MCP servers), and bump `CLAUDE_CODE_VERSION`.
