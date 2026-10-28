// Stand-in for an MCP server that outlived its agent. The file name contains
// "mcp" so name-based detection picks it up. Exits on its own after 60s so a
// failed test never leaves it behind.
setTimeout(() => process.exit(0), 60_000);
setInterval(() => {}, 1000);
