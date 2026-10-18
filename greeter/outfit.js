// ─── Greeter outfit remarks — "that dinosaur sweater is a bold choice" ────────
//
// Optional and OFF by default: this is the one feature that sends a camera
// picture off the computer (to Claude, so it can see the visitor's clothes).
// Only visitors she doesn't recognise, only some of the time (chance on the
// setup page). Her normal greeting plays instantly from cache; this remark is
// written while it plays and follows a beat later — or is dropped if slow.

'use strict';

const MODEL = 'claude-haiku-4-5';

const PROMPT = [
  'You are Lily, a 300-year-old witch (mostly bones now) greeting people at an IT help desk door, with a dry, ' +
  'playful wit and 1700s taste in fashion — modern clothes delight and puzzle you. ' +
  'You have just said hello to the visitor in this camera picture. Add ONE short spoken follow-up ' +
  '(under 18 words) about something they are WEARING or CARRYING: a shirt colour, a slogan or joke ' +
  'printed on it, a logo, a fun pattern, a hat, a costume.',
  'Rules: kind and fun, never sarcastic at their expense. Clothing and accessories ONLY — never comment ' +
  'on their face, body, size, age, hair, skin, gender, ethnicity or disability, and never guess who ' +
  'they are. Skip rude, political or religious slogans. If several people are in view, talk to the ' +
  'nearest. If nothing stands out, the picture is unclear, or you are unsure, return an empty line — ' +
  'silence beats a dull or wrong remark.',
  'Spoken out loud: no emoji, asterisks or quotes.',
].join('\n\n');

function createOutfit({ log = console.log, getApiKey }) {
  let client = null;
  function anthropic() {
    const key = getApiKey();
    if (!key) throw new Error('No Anthropic API key');
    if (!client || client._key !== key) {
      const A = require('@anthropic-ai/sdk');
      client = new (A.default || A)({ apiKey: key, timeout: 8000, maxRetries: 0 });
      client._key = key;
    }
    return client;
  }

  return {
    // -> a line to say, or null
    async remark(jpeg) {
      const t0 = Date.now();
      const response = await anthropic().messages.create({
        model: MODEL,
        max_tokens: 200,
        output_config: { format: { type: 'json_schema', schema: {
          type: 'object', properties: { line: { type: 'string' } }, required: ['line'], additionalProperties: false,
        } } },
        system: [{ type: 'text', text: PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
          { type: 'text', text: 'The visitor at the door.' },
        ] }],
      });
      if (response.stop_reason === 'refusal') return null;
      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const line = String(JSON.parse(text).line || '').trim();
      log(`outfit: ${line ? `"${line}"` : 'nothing to remark on'} (${Date.now() - t0} ms)`);
      return line || null;
    },
  };
}

module.exports = { createOutfit };
