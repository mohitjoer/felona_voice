/**
 * VoiceGraph Flow Example — LangGraph-style conversational state machine.
 *
 * Visualize with:
 *   npx felona visualize ./examples/voice-graph-flow/index.ts
 *   npx felona visualize ./examples/voice-graph-flow/index.ts --open
 */

import { VoiceGraph, START } from "felona-voice";

interface SupportState {
  orderId?: string;
  customerName?: string;
  refundInitiated?: boolean;
}

export const workflow = new VoiceGraph<SupportState>()
  .setState({
    orderId: "ACM-9281",
    customerName: "Alex",
    refundInitiated: false,
  })
  .addNode("greet", {
    description: "Welcome caller warmly and identify their question",
    run: (state) => `Hello ${state.customerName || "there"}! Thank you for calling Acme. How can I assist you today?`,
  })
  .addNode("order_status", {
    description: "Check delivery status, transit location, and carrier arrival time for order",
    run: (state) => `Your order ${state.orderId} is currently out for delivery via FedEx Priority and scheduled to arrive today before 4:30 PM.`,
  })
  .addNode("refund_request", {
    description: "Initiate return, refund request, return shipping label, or billing dispute",
    run: (state) => {
      state.refundInitiated = true;
      return `I have initiated your refund for order ${state.orderId}. A return shipping label has been dispatched to your email on file.`;
    },
  })
  .addNode("transfer_specialist", {
    description: "Escalate to senior tier-2 support lead when customer asks for manager or complex issue",
    run: "I am connecting you with a senior specialist right away. Please hold for just a moment.",
  })
  .addNode("fallback", {
    description: "Out-of-scope questions, trivia, weather, background noise, or unhandled speech",
    run: "Sorry, I am not able to understand. How can I assist you with your order, refund, or account today?",
  })
  .addEdge("greet", "order_status")
  .addEdge("greet", "refund_request")
  .addEdge("greet", "transfer_specialist")
  .addEdge("order_status", "transfer_specialist")
  .addEdge("refund_request", "transfer_specialist")
  .setEntryPoint("greet");

export default workflow;
