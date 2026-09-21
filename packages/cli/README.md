# 🎙️ felona-cli

[![npm version](https://img.shields.io/npm/v/felona-cli.svg?style=flat-square&color=3b82f6)](https://www.npmjs.com/package/felona-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg?style=flat-square)](./LICENSE)

**Command-line interface for Felona Voice — inspect, visualize, test, and scaffold voice agents.**

## Installation

```bash
npm install -g felona-cli
# or execute directly via npx
npx felona-cli --help
```

## Commands

### `felona visualize <file>`

Inspect and visualize conversational node graphs and action spaces from TypeScript files.

```bash
# Render full Markdown documentation (.md) with native Mermaid flowchart & transition tables:
npx felona visualize ./src/agent.ts --md

# Render terminal ASCII box diagram:
npx felona visualize ./src/agent.ts --ascii

# Output raw Mermaid flowchart syntax:
npx felona visualize ./src/agent.ts --mermaid

# Open in Mermaid Live Editor:
npx felona visualize ./src/agent.ts --open

# Export directly to custom output file:
npx felona visualize ./src/agent.ts --md --out docs/agent-graph.md
```

## Documentation & Repository

👉 [https://github.com/felona-voice/felona-voice](https://github.com/felona-voice/felona-voice#readme)

## License

MIT © Felona Voice Contributors
