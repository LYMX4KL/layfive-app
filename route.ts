/**
 * POST /api/ocr-vision
 *
 * Body: { image: "data:image/<fmt>;base64,<...>" }
 * Headers: X-OCR-Secret: <shared secret>  (Phase 1 auth stopgap)
 *
 * Calls Anthropic Claude Haiku vision model to extract roulette numbers
 * from a scoreboard photo. Returns { numbers: number[] } in the order
 * they appear on the board (top-to-bottom).
 *
 * Phase 2 will replace the shared-secret header with Supabase auth +
 * per-user Pro-tier quota enforcement.
 */
import { NextResponse } from "next/server";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
// Sonnet for higher OCR accuracy on LED scoreboards (Haiku misread too many digits).
// Cost is ~5× Haiku but still tiny per-call (~$0.01). Gated to Premium tier anyway.
const MODEL = "claude-sonnet-4-6";

const OCR_PROMPT = `You are reading a casino roulette electronic scoreboard photo.

SCOREBOARD LAYOUT:
- Numbers are displayed in a vertical column (sometimes multiple columns if the history is long).
- Each entry is a roulette result: 0, 00, or 1–36.
- Numbers are typically shown as colored circles or colored text: green for 0/00, red or black for 1–36.
- The most recent spin is usually at the bottom (but sometimes at the top). Read ALL visible numbers in their displayed order, top to bottom, left column first if multiple columns.

Your task: Extract ONLY the numbers you can clearly read, in display order (top to bottom, left to right).

Return ONLY a JSON object in this exact format, with no other text:
{"numbers": [<n1>, <n2>, ...]}

ACCURACY RULES:
1. ONLY include a number if you are confident you can read it correctly.
2. Watch for commonly confused pairs on LED/electronic displays:
   - 6 vs 9 (look at position of the loop)
   - 1 vs 7 (7 has a horizontal stroke at top)
   - 3 vs 8 (8 has two closed loops)
   - 13 vs 18, 23 vs 28, 31 vs 36 — double-check both digits
   - 11 vs 17, 15 vs 16 — verify the second digit carefully
3. If a number is blurry, partly cut off, or genuinely ambiguous — SKIP it entirely. Do not guess.
4. Do NOT extract numbers from text, logos, table-minimum signs, menus, bet amounts, or any UI element. Only read the scoreboard results column.
5. Fewer correct numbers is MUCH better than more numbers with errors.
6. "00" (double zero) → represent as 0.
7. Every entry must be an integer 0–36. Discard anything outside this range.
8. If the photo has no clearly readable scoreboard numbers, return {"numbers": []}.`;

export async function POST(request: Request) {
  try {
    // Phase 1 auth: shared secret. Phase 2 will use Supabase session.
    const provided = request.headers.get("x-ocr-secret");
    const expected = process.env.OCR_SHARED_SECRET;
    if (!expected) {
      return NextResponse.json(
        { error: "Server misconfigured (missing OCR_SHARED_SECRET)" },
        { status: 500 }
      );
    }
    if (!provided || provided !== expected) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Server misconfigured (missing ANTHROPIC_API_KEY)" },
        { status: 500 }
      );
    }

    const body = await request.json();
    const dataUrl: string | undefined = body?.image;
    if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
      return NextResponse.json(
        { error: "Missing or invalid 'image' (expected data: URL)" },
        { status: 400 }
      );
    }

    // Parse the data URL: data:<media>;base64,<payload>
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      return NextResponse.json(
        { error: "Image must be a base64 data URL" },
        { status: 400 }
      );
    }
    const mediaType = match[1];
    const base64 = match[2];

    // Guardrail: cap image size to avoid runaway costs.
    // 5MB base64 ≈ 3.75MB raw, plenty for a cropped scoreboard.
    const MAX_BASE64_BYTES = 5 * 1024 * 1024;
    if (base64.length > MAX_BASE64_BYTES) {
      return NextResponse.json(
        { error: "Image too large (max ~5MB base64)" },
        { status: 413 }
      );
    }

    const anthropicBody = {
      model: MODEL,
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: base64 },
            },
            { type: "text", text: OCR_PROMPT },
          ],
        },
      ],
    };

    const anthropicRes = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(anthropicBody),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error("[ocr-vision] Anthropic error:", anthropicRes.status, errText);
      return NextResponse.json(
        { error: "Vision API error", status: anthropicRes.status },
        { status: 502 }
      );
    }

    const data = await anthropicRes.json();
    const text: string =
      data?.content?.[0]?.type === "text" ? data.content[0].text : "";

    // Parse the numbers out of the model's JSON response. Be permissive in
    // case the model wraps it in markdown or adds whitespace.
    let numbers: number[] = [];
    try {
      const jsonStart = text.indexOf("{");
      const jsonEnd = text.lastIndexOf("}");
      if (jsonStart >= 0 && jsonEnd > jsonStart) {
        const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
        if (Array.isArray(parsed?.numbers)) {
          numbers = parsed.numbers
            .map((n: unknown) => {
              const v = typeof n === "number" ? n : parseInt(String(n), 10);
              return Number.isFinite(v) ? v : NaN;
            })
            .filter((n: number) => n >= 0 && n <= 36);
        }
      }
    } catch (e) {
      console.warn("[ocr-vision] parse failed", e, "raw:", text);
    }

    // Include usage for cost tracking (so Kenny can see per-call token counts).
    return NextResponse.json({
      numbers,
      usage: data?.usage ?? null,
      model: MODEL,
    });
  } catch (err: unknown) {
    console.error("[ocr-vision] error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
