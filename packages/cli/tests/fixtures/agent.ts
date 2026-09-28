/** Minimal scenario fixture used by the CLI tests. */
import { AgentBuilder } from "felona-voice";

export const agent = new AgentBuilder()
  .name("cli-fixture")
  .stt({ provider: "deepgram", apiKey: "test-key" })
  .tts({ provider: "deepgram", apiKey: "test-key" })
  .action("greet", "greet the caller warmly", async () => "Hello!")
  .build();

export const scenarios = [
  {
    name: "greets the caller",
    messages: ["hi"],
    expect: { actionId: "greet" },
  },
];
