/** Minimal graph fixture for the CLI visualize tests. */
import { VoiceGraph, START, END } from "felona-voice";

export const graph = new VoiceGraph()
  .addNode(START, "start")
  .addNode("greet", "greet the caller")
  .addNode(END, "end")
  .addEdge(START, "greet")
  .addEdge("greet", END)
  .compile();
