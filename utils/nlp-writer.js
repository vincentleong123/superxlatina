const nlp = require('compromise');

const SITE_NAME = process.env.SITE_NAME || 'Super X Latina';

const WORD_BANKS = {
  story: {
    verbs: ['unfolds', 'delivers', 'showcases', 'immerses you in', 'brings to life', 'captures', 'builds', 'explores'],
    nouns: ['chemistry', 'scenes', 'moments', 'storyline', 'vibe', 'energy', 'episode', 'atmosphere'],
    adj: ['immersive', 'captivating', 'engrossing', 'dramatic', 'cinematic', 'polished', 'vivid', 'well-paced'],
    lsi: ['latina story', 'amateur latina couple', 'homemade latina video', 'real latina moments', 'latina series', 'hot latina', 'latina streaming', 'latina fan'],
    sounds: ['A must-watch.', 'Scene after scene.', 'So much chemistry.', 'Worth every minute.']
  },
  romance: {
    verbs: ['unfolds', 'explores', 'captures', 'builds', 'deepens', 'reveals', 'brings out', 'focuses on'],
    nouns: ['chemistry', 'romance', 'connection', 'tension', 'moment', 'relationship', 'feeling', 'desire'],
    adj: ['steamy', 'intense', 'passionate', 'sultry', 'sensual', 'magnetic', 'electric', 'breathtaking'],
    lsi: ['latina romance', 'sensual latina', 'passionate latina couple', 'romantic latina video', 'hot latina couple', 'amateur latina', 'HD latina', 'latina passion'],
    sounds: ['The tension is real.', 'So much chemistry.', 'A perfect pairing.', 'Absolutely captivating.']
  },
  wild: {
    verbs: ['delivers', 'hits', 'powers through', 'dominates', 'unleashes', 'smashes', 'races through', 'charges'],
    nouns: ['action', 'heat', 'climax', 'scene', 'sequence', 'energy', 'moment', 'passion'],
    adj: ['explosive', 'high-octane', 'relentless', 'thrilling', 'wild', 'kinetic', 'stunning', 'intense'],
    lsi: ['wild latina', 'hot latina action', 'latina with no limits', 'high-energy latina', 'savage latina', 'HD latina', 'latina streaming', 'latina fan'],
    sounds: ['Non-stop energy.', 'The heat is relentless.', 'Packed with hype moments.', 'Visually explosive.']
  },
  outdoor: {
    verbs: ['unfolds', 'invites you into', 'builds', 'roams', 'transports you to', 'explores', 'brings to life', 'immerses you in'],
    nouns: ['beach', 'balcony', 'backyard', 'street', 'sun', 'heat', 'adventure', 'open air'],
    adj: ['outdoor', 'untamed', 'sun-kissed', 'adventurous', 'breathtaking', 'playful', 'audacious', 'mesmerizing'],
    lsi: ['public latina', 'outdoor latina sex', 'beach latina', 'street latina', 'backyard latina', 'hot latina', 'HD latina', 'latina fan'],
    sounds: ['A world worth entering.', 'Pure outdoor energy.', 'Visually breathtaking.', 'No limits in sight.']
  },
  amateur: {
    verbs: ['explores', 'captures', 'follows', 'focuses on', 'takes you through', 'unfolds', 'builds', 'starts'],
    nouns: ['bedroom', 'couch', 'kitchen', 'living room', 'session', 'angle', 'take', 'confession'],
    adj: ['real', 'authentic', 'playful', 'raw', 'intimate', 'candid', 'vivid', 'unscripted'],
    lsi: ['amateur latina', 'homemade latina video', 'real latina couple', 'candid latina', 'private latina', 'hot latina', 'latina streaming', 'latina fan'],
    sounds: ['Straight off a phone.', 'The energy is infectious.', 'Every scene pops.', 'Raw and real vibes.']
  },
  general: {
    verbs: ['unfolds', 'delivers', 'showcases', 'captures', 'immerses you in', 'brings to life', 'presents', 'takes you into'],
    nouns: ['scene', 'clip', 'latina', 'video', 'sequence', 'experience', 'energy', 'moment'],
    adj: ['immersive', 'captivating', 'stunning', 'polished', 'vivid', 'high-definition', 'entertaining', 'engrossing'],
    lsi: ['latina', 'hot latina', 'latina videos', 'free latina porn', 'HD latina', 'latina streaming', 'amateur latina', 'latina fan'],
    sounds: ['A must-watch.', 'Scene after scene.', 'Absolutely stunning.', 'Worth every minute.']
  }
};

const STOP_WORDS = new Set([
  'a','an','the','is','was','are','were','be','been','being','have','has','had',
  'do','does','did','will','would','can','could','shall','should','may','might',
  'i','you','he','she','it','we','they','me','him','her','us','them','my','your',
  'his','its','our','their','this','that','these','those','in','on','at','by',
  'for','with','about','of','to','from','up','down','out','off','over','under',
  'again','further','then','once','here','there','when','where','why','how',
  'all','each','every','both','few','more','most','other','some','such','no',
  'nor','not','only','own','same','so','than','too','very','just','and','or',
  'but','if','because','as','until','while','after','before','between'
]);

function keywords(title) {
  const doc = nlp(title);
  const words = title.toLowerCase().split(/[\s,;:.!?()'"]+/).filter(w => w.length > 2);
  const unique = [...new Set(words)].filter(w => !STOP_WORDS.has(w));
  const ranked = unique.map(w => {
    const freq = words.filter(x => x === w).length;
    const lengthScore = Math.min(w.length / 10, 0.5);
    return { word: w, score: freq + lengthScore };
  });
  return ranked.sort((a, b) => b.score - a.score);
}

function lsiTerms(category) {
  const bank = WORD_BANKS[category] || WORD_BANKS.general;
  const pool = [...bank.lsi];
  const synonyms = [...(bank.adj || []), ...(bank.nouns || [])];
  const shuffled = [...pool, ...synonyms].sort(() => Math.random() - 0.5);
  return [...new Set(shuffled)].slice(0, 4);
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickN(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

function extractNounsVerbs(text) {
  const doc = nlp(text);
  const nouns = doc.nouns().out('array');
  const verbs = doc.verbs().out('array');
  const adjectives = doc.adjectives().out('array');
  return { nouns, verbs, adjectives };
}

function generateTitleSentence(title, category) {
  const bank = WORD_BANKS[category] || WORD_BANKS.general;
  const verb = pickRandom(bank.verbs);
  const adj = pickRandom(bank.adj);
  const kw = keywords(title);
  const keyTerm = kw.length > 0 ? kw[0].word : pickRandom(bank.nouns);
  const patterns = [
    `🎬 ${SITE_NAME} brings you ${adj} content — ${verb} ${keyTerm || 'something special'} in stunning HD.`,
    `${adj.charAt(0).toUpperCase() + adj.slice(1)} video! ${verb.charAt(0).toUpperCase() + verb.slice(1)} this ${pickRandom(bank.nouns)} — perfect for ${SITE_NAME} fans.`,
    `Watch as this ${adj} clip ${verb} ${pickRandom(bank.nouns)} ${kw.length > 1 ? 'with ' + kw[1].word : 'in full HD quality'}.`,
    `🔥 ${adj.charAt(0).toUpperCase() + adj.slice(1)} alert! ${verb.charAt(0).toUpperCase() + verb.slice(1)} in this ${pickRandom(['amazing','great','fantastic'])} latina video.`,
    `"${kw.length > 0 ? kw[0].word.charAt(0).toUpperCase() + kw[0].word.slice(1) : 'Great content'}!" — ${SITE_NAME} ${verb} ${pickRandom(['smoothly','effortlessly','beautifully','cleanly'])}.`
  ];
  return pickRandom(patterns);
}

function generateSEOSentence(title, category) {
  const bank = WORD_BANKS[category] || WORD_BANKS.general;
  const lsi = pickN(bank.lsi, 2);
  const adj = pickRandom(bank.adj);
  const kw = keywords(title);
  const kwPhrase = kw.length > 0 ? kw.slice(0, 2).map(k => k.word).join(' and ') : pickRandom(bank.lsi);
  const patterns = [
    `Looking for ${lsi[0]} content? This ${adj} clip is a must-watch for ${lsi[1] || 'latina'} fans.`,
    `If you love ${lsi[0]} and ${lsi[1] || 'hot latina'}, you will enjoy this ${adj} video on ${SITE_NAME}.`,
    `Perfect for fans of ${lsi[0]} — watch this ${adj} HD latina video on ${SITE_NAME}.`,
    `Whether you are here for ${lsi[0]} or just love ${lsi[1] || 'great videos'}, this ${adj} clip is worth your time.`,
    `${adj.charAt(0).toUpperCase() + adj.slice(1)} content! ${kwPhrase} — this ${SITE_NAME} video is packed with ${lsi[0]} goodness.`
  ];
  return pickRandom(patterns);
}

function generateStorySentence(title, category) {
  const bank = WORD_BANKS[category] || WORD_BANKS.general;
  const sound = pickRandom(bank.sounds);
  const adj = pickRandom(bank.adj);
  const verb = pickRandom(bank.verbs);
  const noun = pickRandom(bank.nouns);
  const patterns = [
    `This video ${verb} ${noun} in the most ${adj} way. ${sound}`,
    `A ${adj} sequence captured in HD — ${verb} this ${pickRandom(['great','stunning','awesome'])} ${noun}. ${sound}`,
    `${sound} Nothing beats a good ${adj} latina video. ${verb.charAt(0).toUpperCase() + verb.slice(1)} ${noun} with style.`,
    `This ${adj} scene is everything — watch how it ${verb} ${noun}. ${sound}`,
    `${SITE_NAME} delivers ${adj} content. ${sound} Pure quality.`
  ];
  return pickRandom(patterns);
}

function generateCallToAction(category) {
  const patterns = [
    `🔥 Follow ${SITE_NAME} for more HD latina content.`,
    `📹 New videos daily — subscribe for the best ${SITE_NAME} content.`,
    `❤️ Love this? Share this video with friends!`,
    `⭐ ${SITE_NAME} delivers quality — bookmark us for daily HD videos.`,
    `👋 More content coming to ${SITE_NAME} every day. Stay tuned!`,
    `📺 Premium quality, daily updates — only on ${SITE_NAME}.`
  ];
  return pickRandom(patterns);
}

function generatePageSEOText(category, totalVideos) {
  const cat = category || 'latina';
  const patterns = [
    `Explore our collection of ${totalVideos || 'amazing'} videos on ${SITE_NAME}. From ${cat} content to daily updates, there is always something great to watch.`,
    `Looking for ${cat} videos? ${SITE_NAME} has the best HD latina collection. Browse ${totalVideos || 'our'} clips — premium quality guaranteed.`,
    `${SITE_NAME} is your go-to source for HD latina videos. This collection brings you daily content — ${cat} videos, amazing scenes, and pure quality.`
  ];
  return pickRandom(patterns);
}

const STATIC_PREFIXES = [
  'Welcome to {name} — your premium HD latina destination.',
  '{name} brings you the finest latina content every day.',
  'Every video tells a story — {name} curates the best ones.',
  '{name} delivers quality content that keeps you coming back.',
];
const STATIC_SUFFIXES = [
  '🔥 {name} — Premium HD latina content.',
  '{name} is where quality meets quantity.',
  'Life is better with great content from {name}.',
  'Follow {name} for daily entertainment.',
  'Every day is a good day with {name} content.',
];

function staticPrefix() {
  const s = pickRandom(STATIC_PREFIXES);
  return s.replace(/\{name\}/g, SITE_NAME);
}

function staticSuffix() {
  const s = pickRandom(STATIC_SUFFIXES);
  return s.replace(/\{name\}/g, SITE_NAME);
}

function generateFullDescription(title, category) {
  const catLower = category ? category.toLowerCase() : 'general';
  const kw = keywords(title);
  const extract = extractNounsVerbs(title);

  const ts = generateTitleSentence(title, catLower);
  const ss = generateSEOSentence(title, catLower);
  const st = generateStorySentence(title, catLower);
  const cta = generateCallToAction(catLower);
  const prefix = staticPrefix();
  const suffix = staticSuffix();

  const tagList = kw.slice(0, 4).map(k => k.word);
  const tags = tagList.length
    ? `<p style="font-size:13px;color:#9ca3af">Keywords: ${tagList.join(', ')}</p>`
    : '';

  const desc = [
    `<h2>${title.replace(/</g,'&lt;')}</h2>`,
    `<p>${prefix} ${ts}</p>`,
    `<p>${st}</p>`,
    `<p>${ss}</p>`,
    `<p>${suffix}</p>`,
    `<p>${cta}</p>`,
    tags
  ].join('\n');

  return { description: desc, keywords: tagList };
}

function generatePageSEO(category, totalVideos) {
  return generatePageSEOText(category, totalVideos);
}

function regenerateAll(existingVideos, descriptionsMap) {
  const updated = {};
  existingVideos.forEach(v => {
    const result = generateFullDescription(v.title, v.category);
    updated[v.id] = {
      description: result.description,
      keywords: result.keywords,
      generated: true,
      lastUpdated: new Date().toISOString()
    };
    if (descriptionsMap) {
      descriptionsMap.set(v.id, updated[v.id]);
    }
  });
  return updated;
}

module.exports = {
  generateFullDescription,
  generatePageSEO,
  regenerateAll,
  keywords,
  lsiTerms
};
