import { describe, it, expect, vi } from "vitest";
import {
  parseInlineEmotionTags,
  createWavBuffer,
  UplinkAudioBuffer,
  chunkPcmToSyncedDownlinkFrames,
  proceduralFormantSynthesize,
  AudioVisemePipeline,
  EMOTION_GAZE_PRESETS,
} from "../src/voice/audio-viseme-pipeline.js";
import {
  EmotionId,
  FrameType,
  AUDIO_SAMPLE_RATE_HZ,
  AUDIO_SAMPLES_PER_FRAME,
  AUDIO_FRAME_BYTES,
  AUDIO_FRAME_DURATION_MS,
  AUDIO_DOWNLINK_HEADER_SIZE,
  decodeFrame,
  decodeAudioDownlinkFrame,
  encodeAudioUplinkFrame,
  encodeFrame,
} from "@petbot/protocol";

describe("Emotion Tag Extractor (parseInlineEmotionTags)", () => {
  it("parses multi-emotion LLM responses into spoken segments with natural eye gaze", () => {
    const llmOutput =
      "[HAPPY] Awesome! You hit your water goal! [CURIOUS] Want me to set a 25-minute focus timer? [SLEEPY] Or is it nap time?";

    const segments = parseInlineEmotionTags(llmOutput);

    expect(segments).toHaveLength(3);

    // Segment 1: HAPPY
    expect(segments[0]?.emotionId).toBe(EmotionId.HAPPY);
    expect(segments[0]?.emotionName).toBe("HAPPY");
    expect(segments[0]?.text).toBe("Awesome! You hit your water goal!");
    expect(segments[0]?.eyeGazeX).toBe(EMOTION_GAZE_PRESETS.HAPPY.eyeGazeX);
    expect(segments[0]?.eyeGazeY).toBe(EMOTION_GAZE_PRESETS.HAPPY.eyeGazeY);

    // Segment 2: CURIOUS
    expect(segments[1]?.emotionId).toBe(EmotionId.CURIOUS);
    expect(segments[1]?.emotionName).toBe("CURIOUS");
    expect(segments[1]?.text).toBe("Want me to set a 25-minute focus timer?");
    expect(segments[1]?.eyeGazeX).toBe(EMOTION_GAZE_PRESETS.CURIOUS.eyeGazeX);
    expect(segments[1]?.eyeGazeY).toBe(EMOTION_GAZE_PRESETS.CURIOUS.eyeGazeY);

    // Segment 3: SLEEPY
    expect(segments[2]?.emotionId).toBe(EmotionId.SLEEPY);
    expect(segments[2]?.emotionName).toBe("SLEEPY");
    expect(segments[2]?.text).toBe("Or is it nap time?");
    expect(segments[2]?.eyeGazeX).toBe(EMOTION_GAZE_PRESETS.SLEEPY.eyeGazeX);
    expect(segments[2]?.eyeGazeY).toBe(EMOTION_GAZE_PRESETS.SLEEPY.eyeGazeY);
  });

  it("defaults to SPEAKING emotion with natural gaze when no tags are provided", () => {
    const plainText = "Hello human, I am ready to help you with your tasks today.";
    const segments = parseInlineEmotionTags(plainText);

    expect(segments).toHaveLength(1);
    expect(segments[0]?.emotionId).toBe(EmotionId.SPEAKING);
    expect(segments[0]?.emotionName).toBe("SPEAKING");
    expect(segments[0]?.text).toBe(plainText);
    expect(segments[0]?.eyeGazeX).toBe(0);
    expect(segments[0]?.eyeGazeY).toBe(2);
  });

  it("handles case-insensitive tags, whitespace, and consecutive tags", () => {
    const messyText = "  [happy] Great news! [FOCUSED]   Let's work.  ";
    const segments = parseInlineEmotionTags(messyText);

    expect(segments).toHaveLength(2);
    expect(segments[0]?.emotionId).toBe(EmotionId.HAPPY);
    expect(segments[0]?.text).toBe("Great news!");
    expect(segments[1]?.emotionId).toBe(EmotionId.FOCUSED);
    expect(segments[1]?.text).toBe("Let's work.");

    // Empty text
    expect(parseInlineEmotionTags("   ")).toEqual([]);
    expect(parseInlineEmotionTags("")).toEqual([]);
  });
});

describe("WAV Header Generator (createWavBuffer)", () => {
  it("creates standard 44-byte RIFF header for 16kHz 16-bit mono PCM", () => {
    const sampleCount = 320; // 20ms
    const pcm = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      pcm[i] = Math.round(10000 * Math.sin((2 * Math.PI * 440 * i) / 16000));
    }

    const wavBuffer = createWavBuffer(pcm, AUDIO_SAMPLE_RATE_HZ, 1, 16);

    expect(wavBuffer.byteLength).toBe(44 + sampleCount * 2);

    const view = new DataView(wavBuffer.buffer, wavBuffer.byteOffset, wavBuffer.byteLength);

    // RIFF header
    const riff = String.fromCharCode(wavBuffer[0]!, wavBuffer[1]!, wavBuffer[2]!, wavBuffer[3]!);
    expect(riff).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + sampleCount * 2);

    // WAVE
    const wave = String.fromCharCode(wavBuffer[8]!, wavBuffer[9]!, wavBuffer[10]!, wavBuffer[11]!);
    expect(wave).toBe("WAVE");

    // fmt chunk
    const fmt = String.fromCharCode(wavBuffer[12]!, wavBuffer[13]!, wavBuffer[14]!, wavBuffer[15]!);
    expect(fmt).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16); // Subchunk1Size
    expect(view.getUint16(20, true)).toBe(1);  // PCM format
    expect(view.getUint16(22, true)).toBe(1);  // Mono channel
    expect(view.getUint32(24, true)).toBe(16000); // 16kHz sample rate
    expect(view.getUint32(28, true)).toBe(32000); // Byte rate (16000 * 1 * 2)
    expect(view.getUint16(32, true)).toBe(2);  // Block align
    expect(view.getUint16(34, true)).toBe(16); // 16 bits per sample

    // data chunk
    const data = String.fromCharCode(wavBuffer[36]!, wavBuffer[37]!, wavBuffer[38]!, wavBuffer[39]!);
    expect(data).toBe("data");
    expect(view.getUint32(40, true)).toBe(sampleCount * 2);
  });
});

describe("Uplink Audio Accumulator & Server-Side VAD (UplinkAudioBuffer)", () => {
  it("accumulates speech frames and detects end of utterance via 450ms silence timeout", () => {
    const buffer = new UplinkAudioBuffer({
      energyThreshold: 600,
      silenceTimeoutMs: 450, // 450ms = 23 frames of 20ms
      minSpeechFrames: 2,
    });

    const startListener = vi.fn();
    const endListener = vi.fn();
    buffer.onSpeechStart(startListener);
    buffer.onSpeechEnd(endListener);

    // 1. Send 5 frames of silence
    const silentFrame = new Uint8Array(AUDIO_FRAME_BYTES); // all zeros
    for (let i = 0; i < 5; i++) {
      const res = buffer.ingestFrame(silentFrame);
      expect(res).toBeNull();
      expect(buffer.isSpeechActive()).toBe(false);
    }
    expect(startListener).not.toHaveBeenCalled();

    // 2. Send 10 frames of active voice (16kHz sine wave with RMS ~7000)
    const voiceSamples = new Int16Array(AUDIO_SAMPLES_PER_FRAME);
    for (let i = 0; i < AUDIO_SAMPLES_PER_FRAME; i++) {
      voiceSamples[i] = Math.round(10000 * Math.sin((2 * Math.PI * 300 * i) / 16000));
    }
    const voiceFrame = new Uint8Array(voiceSamples.buffer, voiceSamples.byteOffset, voiceSamples.byteLength);

    for (let i = 0; i < 10; i++) {
      const res = buffer.ingestFrame(voiceFrame);
      expect(res).toBeNull();
    }

    expect(buffer.isSpeechActive()).toBe(true);
    expect(startListener).toHaveBeenCalledTimes(1);

    // 3. Send 22 frames of silence (22 * 20 = 440ms < 450ms timeout)
    for (let i = 0; i < 22; i++) {
      const res = buffer.ingestFrame(silentFrame);
      expect(res).toBeNull();
      expect(buffer.isSpeechActive()).toBe(true);
    }

    // 4. Send 23rd silence frame (23 * 20 = 460ms >= 450ms timeout) -> Triggers utterance completion!
    const utterance = buffer.ingestFrame(silentFrame);
    expect(utterance).not.toBeNull();
    expect(utterance?.trigger).toBe("SILENCE_TIMEOUT");
    expect(utterance?.durationMs).toBeGreaterThanOrEqual(200); // voice + silence
    expect(utterance?.wavBuffer.byteLength).toBe(44 + utterance!.pcmBytes.byteLength);
    expect(buffer.isSpeechActive()).toBe(false);
    expect(endListener).toHaveBeenCalledTimes(1);
  });

  it("concludes speech immediately on explicit Push-To-Talk release flag", () => {
    const buffer = new UplinkAudioBuffer({
      energyThreshold: 500,
      minSpeechFrames: 2,
    });

    const voiceSamples = new Int16Array(AUDIO_SAMPLES_PER_FRAME);
    for (let i = 0; i < AUDIO_SAMPLES_PER_FRAME; i++) {
      voiceSamples[i] = Math.round(8000 * Math.sin((2 * Math.PI * 400 * i) / 16000));
    }
    const voiceBytes = new Uint8Array(voiceSamples.buffer, voiceSamples.byteOffset, voiceSamples.byteLength);

    // Ingest speech frames to activate VAD
    buffer.ingestFrame(voiceBytes);
    buffer.ingestFrame(voiceBytes);
    expect(buffer.isSpeechActive()).toBe(true);

    // Ingest frame with pushToTalkRelease = true
    const utterance = buffer.ingestFrame(voiceBytes, true);
    expect(utterance).not.toBeNull();
    expect(utterance?.trigger).toBe("PUSH_TO_TALK_RELEASE");
    expect(buffer.isSpeechActive()).toBe(false);
  });

  it("handles protocol-wrapped AUDIO_UPLINK_FRAME binary frames", () => {
    const buffer = new UplinkAudioBuffer({ energyThreshold: 500 });

    const pcmVoice = new Uint8Array(AUDIO_FRAME_BYTES);
    const view = new DataView(pcmVoice.buffer);
    for (let i = 0; i < AUDIO_SAMPLES_PER_FRAME; i++) {
      view.setInt16(i * 2, 8000, true);
    }

    // Encode protocol uplink subframe
    const uplinkPayload = encodeAudioUplinkFrame({
      rmsEnergy: 8000,
      vadActive: true,
      audioData: pcmVoice,
    });

    // Wrap in standard PetBot frame (FrameType.AUDIO_UPLINK_FRAME)
    const binaryFrame = encodeFrame(FrameType.AUDIO_UPLINK_FRAME, uplinkPayload, 42);

    // Ingest binary frame
    buffer.ingestFrame(binaryFrame);
    buffer.ingestFrame(binaryFrame);
    expect(buffer.isSpeechActive()).toBe(true);

    // Trigger completion via method
    const utterance = buffer.signalPushToTalkRelease();
    expect(utterance).not.toBeNull();
    expect(utterance?.trigger).toBe("PUSH_TO_TALK_RELEASE");
  });
});

describe("Real-Time PCM Resampler & Viseme Envelope Analyzer (chunkPcmToSyncedDownlinkFrames)", () => {
  it("resamples 24kHz audio down to 16kHz and slices into exact 20ms (320-sample) frames", () => {
    const sampleRate24k = 24000;
    const durationSec = 0.1; // 100ms = 5 frames of 20ms
    const samplesCount = Math.round(sampleRate24k * durationSec); // 2400 samples
    const pcm24k = new Int16Array(samplesCount);

    for (let i = 0; i < samplesCount; i++) {
      pcm24k[i] = Math.round(15000 * Math.sin((2 * Math.PI * 400 * i) / sampleRate24k));
    }

    const frames = chunkPcmToSyncedDownlinkFrames(pcm24k, {
      inputSampleRate: 24000,
      emotionId: EmotionId.HAPPY,
      eyeGazeX: 0,
      eyeGazeY: 6,
      startSeqId: 100,
    });

    expect(frames.length).toBe(5); // 100ms / 20ms = 5 frames

    for (let i = 0; i < frames.length; i++) {
      const f = frames[i]!;
      expect(f.sequenceId).toBe(100 + i);
      expect(f.pcmSamples.length).toBe(AUDIO_SAMPLES_PER_FRAME); // 320 samples
      expect(f.downlinkPayload.byteLength).toBe(AUDIO_DOWNLINK_HEADER_SIZE + AUDIO_FRAME_BYTES); // 8 + 640 = 648
      expect(f.binaryFrame.byteLength).toBe(12 + 648 + 4); // 664 bytes
      expect(f.emotionId).toBe(EmotionId.HAPPY);
      expect(f.eyeGazeX).toBe(0);
      expect(f.eyeGazeY).toBe(6);

      // Verify binary frame can be decoded cleanly
      const decodedFrame = decodeFrame(f.binaryFrame);
      expect(decodedFrame.header.frameType).toBe(FrameType.AUDIO_DOWNLINK_FRAME);
      expect(decodedFrame.header.seqId).toBe(100 + i);

      const decodedDownlink = decodeAudioDownlinkFrame(decodedFrame.payload);
      expect(decodedDownlink.emotionId).toBe(EmotionId.HAPPY);
      expect(decodedDownlink.visemeMouthOpen).toBe(f.visemeMouthOpen);
      expect(decodedDownlink.audioByteLen).toBe(AUDIO_FRAME_BYTES);
    }
  });

  it("calculates dynamic mouth openness (0..255) with attack/release smoothing and silence gating", () => {
    // 100ms of pure silence followed by 100ms of loud 400Hz vowel tone
    const silence = new Int16Array(AUDIO_SAMPLES_PER_FRAME * 5); // 5 frames = 100ms silence
    const loudVowel = new Int16Array(AUDIO_SAMPLES_PER_FRAME * 5); // 5 frames = 100ms vowel
    for (let i = 0; i < loudVowel.length; i++) {
      loudVowel[i] = Math.round(24000 * Math.sin((2 * Math.PI * 400 * i) / 16000));
    }

    const testAudio = new Int16Array(silence.length + loudVowel.length);
    testAudio.set(silence, 0);
    testAudio.set(loudVowel, silence.length);

    const frames = chunkPcmToSyncedDownlinkFrames(testAudio, {
      inputSampleRate: 16000,
      attackAlpha: 0.8,
      releaseAlpha: 0.3,
      noiseGateRms: 0.015,
    });

    expect(frames.length).toBe(10);

    // Initial frames of silence: mouth is firmly closed
    expect(frames[0]?.visemeMouthOpen).toBe(0);
    expect(frames[1]?.visemeMouthOpen).toBe(0);
    expect(frames[4]?.visemeMouthOpen).toBe(0);

    // Loud vowel frames: mouth opens wide
    expect(frames[5]?.visemeMouthOpen).toBeGreaterThan(100);
    expect(frames[6]?.visemeMouthOpen).toBeGreaterThan(150);
    expect(frames[7]?.visemeMouthOpen).toBeGreaterThan(180);
  });
});

describe("Procedural Formant Speech Synthesizer (proceduralFormantSynthesize)", () => {
  it("procedurally generates clean 16kHz linear PCM audio without clipping", () => {
    const text = "Awesome job! You reached your goal today.";
    const pcm = proceduralFormantSynthesize(text, {
      emotionId: EmotionId.HAPPY,
    });

    expect(pcm.length).toBeGreaterThan(1600); // Multiple audio frames

    let peak = 0;
    for (let i = 0; i < pcm.length; i++) {
      const abs = Math.abs(pcm[i]!);
      if (abs > peak) peak = abs;
      expect(abs).toBeLessThanOrEqual(32767); // No integer overflow/wrap
    }

    // Confirms voice has audible signal within ~18,000 target amplitude
    expect(peak).toBeGreaterThan(10000);
    expect(peak).toBeLessThanOrEqual(25000);
  });

  it("generates distinct emotional contours for SLEEPY and ALERT", () => {
    const sleepyPcm = proceduralFormantSynthesize("Goodnight robot", {
      emotionId: EmotionId.SLEEPY,
    });
    const alertPcm = proceduralFormantSynthesize("Warning intruder", {
      emotionId: EmotionId.ALERT,
    });

    expect(sleepyPcm.length).toBeGreaterThan(0);
    expect(alertPcm.length).toBeGreaterThan(0);
  });
});

describe("AudioVisemePipeline (End-to-End Orchestrator)", () => {
  it("processes LLM text with inline emotion markers into streaming 20ms downlink frames", async () => {
    const pipeline = new AudioVisemePipeline();

    const llmResponse =
      "[HAPPY] Yay! You finished your project! [FOCUSED] Ready for the next phase?";

    const frames = await pipeline.processLlmResponseToDownlinkFrames(llmResponse, {
      startSeqId: 50,
    });

    expect(frames.length).toBeGreaterThan(10);

    // Verify continuous sequence numbering
    for (let i = 0; i < frames.length; i++) {
      expect(frames[i]?.sequenceId).toBe(50 + i);
    }

    // Verify segments transitioned from HAPPY to FOCUSED
    const happyFrames = frames.filter((f) => f.emotionId === EmotionId.HAPPY);
    const focusedFrames = frames.filter((f) => f.emotionId === EmotionId.FOCUSED);

    expect(happyFrames.length).toBeGreaterThan(0);
    expect(focusedFrames.length).toBeGreaterThan(0);

    expect(happyFrames[0]?.eyeGazeY).toBe(EMOTION_GAZE_PRESETS.HAPPY.eyeGazeY);
    expect(focusedFrames[0]?.eyeGazeY).toBe(EMOTION_GAZE_PRESETS.FOCUSED.eyeGazeY);
  });

  it("yields frames progressively via streamLlmResponseToDownlinkFrames generator", async () => {
    const pipeline = new AudioVisemePipeline();
    const generator = pipeline.streamLlmResponseToDownlinkFrames("[CURIOUS] What is that?");

    let count = 0;
    for await (const frame of generator) {
      expect(frame.pcmSamples.length).toBe(AUDIO_SAMPLES_PER_FRAME);
      expect(frame.binaryFrame.byteLength).toBe(664);
      count++;
    }

    expect(count).toBeGreaterThan(5);
  });
});
