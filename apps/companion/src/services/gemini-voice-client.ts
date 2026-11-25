import { EmotionId } from "@petbot/protocol";

export interface GeminiVoiceAction {
  type:
    | "OPEN_APP"
    | "SEARCH_WEB"
    | "CALL"
    | "ALARM"
    | "TIMER"
    | "NAVIGATE"
    | "TORCH"
    | "RINGER"
    | "MEDIA"
    | "ADD_HABIT"
    | "COMPLETE_HABIT"
    | "SAVE_NOTE"
    | "WIDGET"
    | "NONE";
  params: Record<string, string | number | boolean>;
}

export interface GeminiVoiceTurnResponse {
  transcript: string;
  spokenReply: string;
  emotion: EmotionId;
  action: GeminiVoiceAction;
  usedGemini: boolean;
}

const GEMINI_KEY_STORAGE = "lobo_gemini_api_key";

export function getSavedGeminiApiKey(): string {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem(GEMINI_KEY_STORAGE)?.trim() ?? "";
    }
  } catch {
    // ignore storage errors
  }
  return "";
}

export function saveGeminiApiKey(apiKey: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      const clean = apiKey.trim();
      if (clean) {
        localStorage.setItem(GEMINI_KEY_STORAGE, clean);
      } else {
        localStorage.removeItem(GEMINI_KEY_STORAGE);
      }
    }
  } catch {
    // ignore storage errors
  }
}

/**
 * Encodes 16kHz 16-bit mono PCM bytes into a standard 44-byte RIFF WAV container.
 */
export function pcm16ToWavBytes(pcmBytes: Uint8Array, sampleRate = 16000): Uint8Array {
  const dataSize = pcmBytes.byteLength - (pcmBytes.byteLength % 2);
  const wav = new Uint8Array(44 + dataSize);
  const view = new DataView(wav.buffer);

  // "RIFF"
  wav[0] = 0x52;
  wav[1] = 0x49;
  wav[2] = 0x46;
  wav[3] = 0x46;
  view.setUint32(4, 36 + dataSize, true);
  // "WAVE"
  wav[8] = 0x57;
  wav[9] = 0x41;
  wav[10] = 0x56;
  wav[11] = 0x45;
  // "fmt "
  wav[12] = 0x66;
  wav[13] = 0x6d;
  wav[14] = 0x74;
  wav[15] = 0x20;
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // Byte rate
  view.setUint16(32, 2, true); // Block align
  view.setUint16(34, 16, true); // Bits per sample
  // "data"
  wav[36] = 0x64;
  wav[37] = 0x61;
  wav[38] = 0x74;
  wav[39] = 0x61;
  view.setUint32(40, dataSize, true);

  wav.set(pcmBytes.subarray(0, dataSize), 44);
  return wav;
}

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x4000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    for (let j = 0; j < slice.length; j++) {
      binary += String.fromCharCode(slice[j]!);
    }
  }
  return btoa(binary);
}

export function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function mapEmotionName(name: string | undefined): EmotionId {
  switch ((name || "").toUpperCase()) {
    case "FOCUSED":
      return EmotionId.FOCUSED;
    case "CURIOUS":
      return EmotionId.CURIOUS;
    case "SLEEPY":
      return EmotionId.SLEEPY;
    case "ALERT":
      return EmotionId.ALERT;
    case "SPEAKING":
      return EmotionId.SPEAKING;
    default:
      return EmotionId.HAPPY;
  }
}

function parseGeminiJsonPayload(
  rawText: string,
  fallbackTranscript = ""
): Omit<GeminiVoiceTurnResponse, "usedGemini"> {
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    const obj = JSON.parse(cleaned) as {
      transcript?: string;
      spokenReply?: string;
      emotion?: string;
      action?: { type?: string; params?: Record<string, string | number | boolean> };
    };
    return {
      transcript: obj.transcript || fallbackTranscript,
      spokenReply: obj.spokenReply || "Done.",
      emotion: mapEmotionName(obj.emotion),
      action: {
        type: (obj.action?.type as GeminiVoiceAction["type"]) || "NONE",
        params: obj.action?.params || {},
      },
    };
  } catch {
    return {
      transcript: fallbackTranscript,
      spokenReply: cleaned.slice(0, 180) || "Okay.",
      emotion: EmotionId.HAPPY,
      action: { type: "NONE", params: {} },
    };
  }
}

export interface GeminiContextSnapshot {
  habits: string[];
  widgets: string[];
  persona: string;
}

function buildSystemInstruction(ctx: GeminiContextSnapshot): string {
  return [
    `You are Lobo (${ctx.persona}), a fast desk companion robot connected to the user's Android phone.`,
    `User habits: ${ctx.habits.join(", ") || "none"}.`,
    `Robot screens/widgets: ${ctx.widgets.join(", ")}.`,
    `Respond ONLY with valid JSON (no markdown fences):`,
    `{"transcript":"<what user asked>","spokenReply":"<short natural reply max 2 sentences>","emotion":"HAPPY|FOCUSED|CURIOUS|ALERT","action":{"type":"OPEN_APP|SEARCH_WEB|CALL|ALARM|TIMER|NAVIGATE|TORCH|RINGER|MEDIA|ADD_HABIT|COMPLETE_HABIT|SAVE_NOTE|WIDGET|NONE","params":{}}}`,
    `Action param rules:`,
    `- OPEN_APP: {"appName":"YouTube"}`,
    `- SEARCH_WEB: {"query":"...","target":"google|youtube"}`,
    `- CALL: {"phoneNumber":"..."}`,
    `- ALARM: {"hour":7,"minutes":0,"message":"..."}`,
    `- TIMER: {"seconds":300,"message":"..."}`,
    `- NAVIGATE: {"destination":"..."}`,
    `- TORCH: {"enabled":true}`,
    `- RINGER: {"mode":"SILENT|VIBRATE|NORMAL"}`,
    `- MEDIA: {"command":"PLAY|PAUSE|PLAY_PAUSE|NEXT|PREVIOUS"}`,
    `- ADD_HABIT: {"title":"..."}`,
    `- COMPLETE_HABIT: {"title":"..."}`,
    `- SAVE_NOTE: {"text":"..."}`,
    `- WIDGET: {"name":"Clock|Habits Tracker|Quick Notes|Focus Timer|Hydration|Pet Face"}`,
  ].join("\n");
}

async function callGeminiGenerateContent(
  apiKey: string,
  parts: Array<Record<string, unknown>>,
  ctx: GeminiContextSnapshot
): Promise<string> {
  const models = ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-1.5-flash"];
  let lastError: Error | null = null;

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: buildSystemInstruction(ctx) }] },
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0.25,
          maxOutputTokens: 240,
          responseMimeType: "application/json",
        },
      }),
    });

    if (response.ok) {
      const json = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      if (text.trim()) {
        return text;
      }
    }

    lastError = new Error(`Gemini ${model} failed (${response.status})`);
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw lastError;
    }
  }

  throw lastError ?? new Error("Gemini API unreachable");
}

export async function processVoiceWavWithGemini(
  wavBytes: Uint8Array,
  ctx: GeminiContextSnapshot,
  apiKey = getSavedGeminiApiKey()
): Promise<GeminiVoiceTurnResponse> {
  if (!apiKey) {
    return {
      transcript: "[Voice audio received]",
      spokenReply: "Add your Gemini API key in Voice settings so I can understand voice audio.",
      emotion: EmotionId.FOCUSED,
      action: { type: "NONE", params: {} },
      usedGemini: false,
    };
  }

  const rawText = await callGeminiGenerateContent(
    apiKey,
    [
      {
        inlineData: {
          mimeType: "audio/wav",
          data: uint8ToBase64(wavBytes),
        },
      },
      { text: "Listen to this audio command and return the JSON response." },
    ],
    ctx
  );

  return {
    ...parseGeminiJsonPayload(rawText),
    usedGemini: true,
  };
}

export async function processTextWithGemini(
  userText: string,
  ctx: GeminiContextSnapshot,
  apiKey = getSavedGeminiApiKey()
): Promise<GeminiVoiceTurnResponse | null> {
  if (!apiKey) return null;

  const rawText = await callGeminiGenerateContent(apiKey, [{ text: userText }], ctx);
  return {
    ...parseGeminiJsonPayload(rawText, userText),
    usedGemini: true,
  };
}

/**
 * Generates clean 16kHz 16-bit mono speech PCM bytes via native Android TextToSpeech WAV
 * synthesis when running in Capacitor, or crisp chime/envelope PCM fallback on desktop/tests.
 */
export async function synthesizeReplyToPcm16(text: string): Promise<Uint8Array> {
  const cleanText = text.trim() || "Ready.";

  if (typeof window !== "undefined") {
    const cap = (window as unknown as {
      Capacitor?: { isPluginAvailable?: (n: string) => boolean; Plugins?: Record<string, any> };
    }).Capacitor;
    const plugin = cap?.isPluginAvailable?.("PetBotMobileHarness")
      ? cap.Plugins?.PetBotMobileHarness
      : null;

    if (plugin && typeof plugin.synthesizeSpeechToWav === "function") {
      try {
        const res = await plugin.synthesizeSpeechToWav({ text: cleanText });
        if (res?.success && typeof res.base64Pcm === "string" && res.base64Pcm.length > 0) {
          return base64ToUint8(res.base64Pcm);
        }
      } catch (err) {
        console.warn("Native TTS WAV synthesis failed, using PCM fallback:", err);
      }
    }
  }

  // Fallback compact expressive vocal cadence PCM @ 16kHz for headless tests / non-TTS envs
  const words = Math.max(1, Math.min(8, cleanText.split(/\s+/).length));
  const durationSec = Math.max(0.32, Math.min(1.8, words * 0.16));
  const sampleCount = Math.floor(durationSec * 16000);
  const pcm = new Int16Array(sampleCount);
  const syllableSamples = Math.max(1200, Math.floor(sampleCount / words));

  for (let i = 0; i < sampleCount; i++) {
    const t = i / 16000;
    const sylIdx = Math.floor(i / syllableSamples);
    const localPos = (i % syllableSamples) / syllableSamples;
    const env = Math.sin(localPos * Math.PI);
    const baseFreq = 210 + ((sylIdx * 47) % 95);
    const sample =
      (Math.sin(2 * Math.PI * baseFreq * t) * 0.55 +
        Math.sin(2 * Math.PI * (baseFreq * 2.02) * t) * 0.3 +
        Math.sin(2 * Math.PI * (baseFreq * 3.1) * t) * 0.15) *
      env *
      22000;
    pcm[i] = Math.max(-32767, Math.min(32767, Math.round(sample)));
  }

  return new Uint8Array(pcm.buffer);
}
