// No MCP tool inputs: the engine writes this file from the servers a session has connected, which are the
// developer's own and not the plugin's, so the snapshot keeps it empty.
export {}
declare module 'claude-code' {
  interface McpToolInputs {
  }
}
