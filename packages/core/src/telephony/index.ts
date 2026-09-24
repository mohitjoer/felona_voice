export {
  mulawToPcm16,
  pcm16ToMulaw,
  resamplePcm16,
  mulaw8kToPcm16k,
  pcm16ToMulaw8k,
  linearSampleToMulaw,
} from "./codec.js";

export {
  createTwilioStreamTwiML,
  createTelnyxStreamTeXML,
  makeTwilioCall,
  type TwilioStreamTwiMLOptions,
  type TwilioOutboundCallOptions,
  type TwilioCallResult,
} from "./twiml.js";

export {
  TwilioTransport,
  createTwilioTransport,
  type TwilioTransportOptions,
} from "./twilio-transport.js";
