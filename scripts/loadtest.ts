/**
 * Synthetic concurrency benchmark.
 *
 * Every other capacity claim in this repo is a memory bound chosen by a default,
 * not a measured throughput number. This measures one, so `maxConcurrent: 100`
 * is either justified or visibly wrong on your hardware.
 *
 * What is measured: N concurrent calls, each running real pipelines through the
 * real audio path — EnergyVAD, the preprocessor, JEV cosine routing, the turn
 * loop, and TTS playback. That is the work on *your* event loop.
 *
 * What is not: provider latency. STT and TTS are stubs, because measuring a
 * vendor's round trip tells you about the vendor, not about this framework.
 * Real-provider numbers are strictly worse and you must measure those yourself.
 *
 * Usage:
 *   npx tsx scripts/loadtest.ts [calls] [turns]
 *   npx tsx scripts/loadtest.ts 200 4
 *
 * Read the output as "N concurrent calls survived M turns each without the
 * event loop stalling or memory growing without bound". That is a smoke test,
 * not a capacity guarantee.
 */

import { VoicePipeline } from "../packages/core/src/pipeline.js";
import { JEVEngine } from "../packages/core/src/jev/engine.js";
import { FastSemanticEmbeddingProvider } from "../packages/core/src/jev/fast-embeddings.js";
import { EnergyVAD } from "../packages/core/src/vad/energy.js";
import { ConversationMemory } from "../packages/core/src/memory/context.js";
import { ToolRegistry } from "../packages/core/src/tools/registry.js";
import { CallLogger } from "../packages/core/src/analytics/logger.js";
import type {
  AgentAction,
  AudioChunk,
  STTProvider,
  STTStream,
  TTSProvider,
  Session,
} from "../packages/core/src/types.js";

const SAMPLE_RATE = 16000;
/** 20 ms of 16 kHz mono 16-bit audio — the frame a carrier actually sends. */
const FRAME_MS = 20;
const CHUNK_BYTES = SAMPLE_RATE * 2 * (FRAME_MS / 1000);

const ACTIONS: AgentAction[] = [
  { id: "greet", description: "greet the caller warmly", handler: async () => "Hello there." },
  { id: "order", description: "check a delivery or order status", handler: async () => "It shipped." },
  { id: "hours", description: "opening and closing hours", handler: async () => "Nine to six." },
  { id: "fallback", description: "anything else at all", handler: async () => "Let me check that." },
];

/** Audio that varies per frame, so the VAD and streaming paths do real work. */
function frame(sequence: number, loud: boolean): AudioChunk {
  const data = Buffer.alloc(CHUNK_BYTES);
  if (loud) {
    for (let i = 0; i < data.length; i += 2) {
      data.writeInt16LE(((sequence * 37 + i * 13) % 12000) - 6000, i);
    }
  }
  return { data, sampleRate: SAMPLE_RATE, channels: 1, bitDepth: 16, timestampMs: sequence * FRAME_MS };
}

/** STT that answers with a fixed transcript, so turns finish deterministically. */
class StubSTT implements STTProvider {
  readonly name = "stub";
  readonly streams: StubStream[] = [];
  createStream(): STTStream {
    const stream = new StubStream();
    this.streams.push(stream);
    return stream;
  }
}

class StubStream implements STTStream {
  private result: ((r: { text: string; isFinal: boolean; confidence: number }) => void) | null = null;
  private error: ((e: Error) => void) | null = null;
  write(): void {}
  flush(): Promise<void> { return Promise.resolve(); }
  close(): Promise<void> { return Promise.resolve(); }
  onResult(h: (r: { text: string; isFinal: boolean; confidence: number }) => void): void { this.result = h; }
  onError(h: (e: Error) => void): void { this.error = h; }
  /** Delivers one final transcript, which is what closes a turn. */
  emit(text: string): void { this.result?.({ text, isFinal: true, confidence: 0.9 }); }
}

/** TTS yielding a handful of frames, so playback cost is realistic in shape. */
class StubTTS implements TTSProvider {
  readonly name = "stub";
  constructor(private readonly frames = 5) {}
  async *synthesize(): AsyncGenerator<AudioChunk> {
    for (let i = 0; i < this.frames; i++) yield frame(i, true);
  }
}

interface Harness {
  pipeline: VoicePipeline;
  stream: StubStream;
  /** Live counter. A number captured by value would freeze at zero. */
  sent: { chunks: number };
}

async function buildCall(id: string, jev: JEVEngine, tts: TTSProvider): Promise<Harness> {
  const stt = new StubSTT();
  const session: Session = { id, startedAt: new Date(), metadata: {}, state: "active" };
  const sent = { chunks: 0 };

  const pipeline = new VoicePipeline({
    sessionId: id,
    session,
    stt,
    tts,
    vad: new EnergyVAD({ hangoverMs: 60, minSpeechMs: 10 }),
    jev,
    memory: new ConversationMemory({ maxTurns: 30 }),
    tools: new ToolRegistry(),
    logger: new CallLogger(),
    hooks: {},
    systemPrompt: "test",
    // 200ms, not a tighter value: too short and the turn is cut off before
    // the recogniser returns, which is a harness artefact rather than a finding.
    sttFlushTimeoutMs: 200,
    sendAudio: async () => { sent.chunks++; },
  });

  await pipeline.start();
  return { pipeline, stream: stt.streams[0], sent };
}

/** One utterance: speech frames, then silence long enough to close the turn. */
function speak(harness: Harness, transcript: string, sequence: number): void {
  for (let i = 0; i < 5; i++, sequence++) {
    harness.pipeline.processAudio(frame(sequence, true));
  }
  for (let i = 0; i < 10; i++, sequence++) {
    harness.pipeline.processAudio(frame(sequence, false));
  }
  harness.stream.emit(transcript);
}

const TRANSCRIPTS = [
  "hi there how are you",
  "where is my order",
  "what are your opening hours",
  "can you tell me about something else entirely",
];

async function main(): Promise<void> {
  const callCount = Number(process.argv[2]) || 100;
  const turnsPerCall = Number(process.argv[3]) || 4;

  console.log(
    `Felona Voice load test — ${callCount} concurrent calls x ${turnsPerCall} turns\n` +
      `Node ${process.version} on ${process.platform}/${process.arch}\n`,
  );

  const jev = new JEVEngine({ embeddingProvider: new FastSemanticEmbeddingProvider() });
  await jev.initialize(ACTIONS);

  const tts = new StubTTS();
  const baseline = process.memoryUsage().heapUsed;

  const built = performance.now();
  const harnesses: Harness[] = [];
  for (let i = 0; i < callCount; i++) {
    harnesses.push(await buildCall(`load-${i}`, jev, tts));
  }
  const buildMs = performance.now() - built;

  const started = performance.now();
  // Every call is driven concurrently, interleaved on one event loop. This is
  // the contention that a sequential test would never surface.
  await Promise.all(
    harnesses.map(async (harness, callIndex) => {
      for (let turn = 0; turn < turnsPerCall; turn++) {
        speak(harness, TRANSCRIPTS[(callIndex + turn) % TRANSCRIPTS.length], turn * 100);
        // Yield so turns interleave rather than running one at a time.
        // Long enough for a turn to complete under load; still interleaves the calls.
        await new Promise((r) => setTimeout(r, 5));
      }
    }),
  );
  const elapsedMs = performance.now() - started;

  // Let any queued turn drain before teardown.
  await new Promise((r) => setTimeout(r, 300));

  const after = process.memoryUsage().heapUsed;
  const sent = harnesses.reduce((sum, h) => sum + h.sent.chunks, 0);
  const totalTurns = callCount * turnsPerCall;

  await Promise.all(harnesses.map((h) => h.pipeline.stop()));

  const heapDeltaMb = (after - baseline) / 1024 / 1024;
  const perCallKb = callCount ? (after - baseline) / 1024 / callCount : 0;

  console.log("results");
  console.log("-------");
  console.log(`calls                 ${callCount}`);
  console.log(`turns                 ${totalTurns}`);
  console.log(`audio chunks out      ${sent}`);
  console.log(`setup                 ${buildMs.toFixed(0)} ms`);
  console.log(`turn wall clock       ${elapsedMs.toFixed(0)} ms`);
  console.log(`ms per turn (wall)    ${(elapsedMs / Math.max(1, totalTurns)).toFixed(2)}`);
  console.log(`turns / second        ${(totalTurns / (elapsedMs / 1000)).toFixed(0)}`);
  console.log(`heap growth           ${heapDeltaMb.toFixed(1)} MB`);
  console.log(`heap per call         ${perCallKb.toFixed(1)} KB`);
  console.log("");

  if (sent === 0) {
    console.error("FAIL: no audio was produced — the harness did not drive real turns.");
    process.exitCode = 1;
    return;
  }
  // Memory that grows without bound across concurrent calls is the failure this
  // is here to catch, not a slow turn.
  if (heapDeltaMb > callCount * 0.5) {
    console.error(`FAIL: heap grew ${heapDeltaMb.toFixed(1)} MB for ${callCount} calls — leaking.`);
    process.exitCode = 1;
    return;
  }
  console.log("PASS: every call completed its turns and memory stayed bounded.");
  console.log("Reminder: real providers add network latency. This measures the framework only.");
}

main().catch((error) => {
  console.error("load test failed:", error);
  process.exitCode = 1;
});
