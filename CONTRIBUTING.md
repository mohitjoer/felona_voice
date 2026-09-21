# Contributing to Felona Voice

Thank you for your interest in contributing to **Felona Voice**! We are committed to building the premier open-source voice agent framework.

---

## 🛠️ Development Setup

### Prerequisites
- Node.js ≥ 20.0.0
- npm ≥ 10.0.0

### Getting Started

1. **Fork and clone the repository:**
   ```bash
   git clone https://github.com/your-username/felona-voice.git
   cd felona-voice
   ```

2. **Install all workspace dependencies:**
   ```bash
   npm install
   ```

3. **Build the packages:**
   ```bash
   npm run build
   ```

4. **Run the test suite:**
   ```bash
   npm test
   ```

---

## 📁 Repository Structure

```
packages/
├── core/                  # Core runtime engine & providers
│   ├── src/
│   │   ├── agent.ts       # FelAgent main entrypoint
│   │   ├── builder.ts     # Fluent AgentBuilder API
│   │   ├── graph/         # LangGraph-style VoiceGraph & Visualizers
│   │   ├── jev/           # Joint Embedding Vector neural routing
│   │   ├── pipeline.ts    # Audio streaming pipeline orchestrator
│   │   ├── stt/           # Speech-to-Text providers (Deepgram)
│   │   ├── tts/           # Text-to-Speech providers (Deepgram, ElevenLabs)
│   │   └── vad/           # Voice Activity Detection
│   └── tests/             # Vitest test suite
└── cli/                   # Developer CLI (felona-cli)
    └── src/index.ts       # CLI commands (visualize, dev)
examples/                  # Reference examples & templates
```

---

## 🧪 Testing Guidelines

We use [Vitest](https://vitest.dev/) for unit and integration testing.

- Write tests alongside your changes in `packages/core/tests/`.
- Ensure all tests pass before submitting a pull request:
  ```bash
  npm test
  ```
- Run tests in watch mode during development:
  ```bash
  npm run test:watch --workspace=felona-voice
  ```

---

## 🎨 Coding Standards

- **TypeScript Only**: Pure TypeScript/ESM (Node.js ≥ 20).
- **Naming Conventions**:
  - Files: `kebab-case.ts`
  - Classes & Types: `PascalCase`
  - Functions & Variables: `camelCase`
- **Extensibility**: All audio, STT, TTS, and VAD providers implement pluggable interfaces defined in `packages/core/src/types.ts`.
- **Zero Heavy Native Dependencies**: Keep cold-start fast and installation lightweight.

---

## 🚀 Submitting a Pull Request

1. Create a feature branch:
   ```bash
   git checkout -b feature/my-new-feature
   ```
2. Commit your changes with clear, descriptive commit messages.
3. Push to your fork:
   ```bash
   git push origin feature/my-new-feature
   ```
4. Open a Pull Request against the `main` branch.

Thank you for helping make Felona Voice better for developers everywhere!
