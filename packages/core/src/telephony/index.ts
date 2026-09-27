export {
  mulawToPcm16,
  pcm16ToMulaw,
  alawToPcm16,
  pcm16ToAlaw,
  resamplePcm16,
  mulaw8kToPcm16k,
  alaw8kToPcm16k,
  pcm16ToMulaw8k,
  pcm16ToAlaw8k,
  linearSampleToMulaw,
  linearSampleToAlaw,
  decodeTelephonyAudio,
  encodeTelephonyAudio,
  PIPELINE_SAMPLE_RATE,
  type G711Encoding,
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

export {
  TwilioTransferProvider,
  createTwilioTransferProvider,
  buildTransferTwiml,
  type TwilioTransferOptions,
  type TransferMode,
  type TransferRequest,
  type TransferResult,
  type CallTransferProvider,
} from "./transfer.js";
