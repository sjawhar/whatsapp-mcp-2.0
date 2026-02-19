interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
}

function getConfig() {
  const apiKey = process.env.WHISPER_API_KEY;
  const apiUrl = process.env.WHISPER_API_URL;

  if (!apiKey || !apiUrl) {
    throw new Error(
      "Voice note transcription requires WHISPER_API_KEY and WHISPER_API_URL environment variables. " +
      "Set them in your Claude Desktop MCP config under the \"env\" block for the WhatsApp server.\n" +
      "Example for Groq (free): WHISPER_API_URL=https://api.groq.com/openai/v1/audio/transcriptions, " +
      "WHISPER_API_KEY=gsk_...\n" +
      "Example for OpenAI: WHISPER_API_URL=https://api.openai.com/v1/audio/transcriptions, " +
      "WHISPER_API_KEY=sk-..."
    );
  }

  return {
    apiUrl,
    apiKey,
    model: process.env.WHISPER_MODEL || "whisper-large-v3-turbo",
  };
}

export async function transcribeAudio(
  buffer: Buffer,
  fileName: string
): Promise<TranscriptionResult> {
  const config = getConfig();

  const formData = new FormData();
  formData.append("file", new Blob([new Uint8Array(buffer)]), fileName);
  formData.append("model", config.model);
  formData.append("response_format", "verbose_json");

  const response = await fetch(config.apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Transcription API error (${response.status}): ${errorText}`);
  }

  const result = (await response.json()) as {
    text: string;
    language?: string;
    duration?: number;
  };

  return {
    text: deduplicateText(result.text),
    language: result.language,
    duration: result.duration,
  };
}

/**
 * Whisper models sometimes hallucinate by repeating sentences.
 * This detects and removes consecutive duplicate sentences.
 */
function deduplicateText(text: string): string {
  const sentences = text.match(/[^.!?]+[.!?]+/g);
  if (!sentences) return text;

  const trimmed = sentences.map((s) => s.trim());
  const deduped: string[] = [];
  for (const sentence of trimmed) {
    if (deduped.length === 0 || sentence !== deduped[deduped.length - 1]) {
      deduped.push(sentence);
    }
  }
  return deduped.join(" ");
}
