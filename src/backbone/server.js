const express = require('express');
const cors = require('cors');

const path = require('path');

const configLoader = require('../lib/config');
let config = {};
try {
  config = configLoader.loadConfig();
} catch (err) {
  console.error('Failed to load config, exiting:', err.message);
  process.exit(1);
}

let providers = [];

function reloadProviders(cfg) {
  providers = [];
  for (const [name, opts] of Object.entries((cfg && cfg.providers) || {})) {
    if (!opts.enabled) {
      console.log(`Provider ${name} is disabled in config`);
      continue;
    }

    try {
      const candidate = require.resolve(path.resolve(__dirname, '..', name, 'provider.js'));
      // eslint-disable-next-line import/no-dynamic-require
      const ProviderClass = require(candidate);
      const instance = new ProviderClass(opts);
      providers.push({ name, instance, opts, ProviderClass });
      console.log(`Loaded provider ${name}`);
    } catch (err) {
      console.error(`Could not load provider ${name}:`, err.message);
    }
  }
}

// initial load
reloadProviders(config);

const app = express();
const port = process.env.PORT || 4000;
app.use(cors());

const stringSimilarity = require('string-similarity');

app.get('/search', async (req, res) => {
  const q = req.query.query;
  const author = req.query.author;
  if (!q) return res.status(400).json({ error: 'query required' });

  const tasks = providers.map(async (p) => {
    try {
      const providerLang = (config.providers && config.providers[p.name] && config.providers[p.name].language) || undefined;
      const results = await p.instance.searchBooks(q, author, providerLang);
      return { provider: p.name, matches: results.matches || [] };
    } catch (err) {
      return { provider: p.name, error: String(err) };
    }
  });

  const all = await Promise.all(tasks);

  const combined = all.reduce((acc, cur) => {
    if (cur.matches) {
      const providerCfg = (config.providers && config.providers[cur.provider]) || {};
      const priority = typeof providerCfg.priority === 'number' ? providerCfg.priority : 0;
      const tagged = cur.matches.map(m => ({ ...m, _provider: cur.provider, _providerPriority: priority }));
      return acc.concat(tagged);
    }
    return acc;
  }, []);

  // Normalize authors field on snippets so scoring code can safely call toLowerCase()
  for (const m of combined) {
    if (Array.isArray(m.authors)) {
      m.authors = m.authors.map(a => (typeof a === 'string' ? a.trim() : (a ? String(a).trim() : ''))).filter(Boolean);
    } else if (m.author && typeof m.author === 'string') {
      m.authors = m.author.split(/\s*(?:,|;| and )\s*/).map(s => s.trim()).filter(Boolean);
    } else {
      m.authors = [];
    }
  }

  // Log provider snippet counts (minimal but informative)
  try {
    const providerSnippetCounts = {};
    for (const a of all) {
      providerSnippetCounts[a.provider] = (a.matches && a.matches.length) || 0;
    }
    console.log('[search] provider snippets:', JSON.stringify(providerSnippetCounts));
  } catch (e) { /* ignore logging errors */ }

  const cleanedQuery = q.trim().toLowerCase();
  const cleanedAuthor = author ? author.trim().toLowerCase() : '';
  const titleWeight = (config.global && typeof config.global.titleWeight === 'number') ? (config.global.titleWeight / 100) : 0.6;
  const authorWeight = 1 - titleWeight;

  const scored = combined.map(m => {
    const title = (m.title || '').toString().toLowerCase();
    const titleSimilarity = stringSimilarity.compareTwoStrings(title, cleanedQuery);

    let combinedSimilarity = titleSimilarity;
    if (cleanedAuthor && Array.isArray(m.authors) && m.authors.length) {
      const bestAuthorSim = Math.max(...m.authors.map(a => stringSimilarity.compareTwoStrings((a||'').toLowerCase(), cleanedAuthor)));
      combinedSimilarity = (titleSimilarity * titleWeight) + (bestAuthorSim * authorWeight);
    }

    return { ...m, similarity: combinedSimilarity };
  });

  // Apply global allowBooks/allowAudiobooks filters from config
  const allowBooks = config.global && typeof config.global.allowBooks !== 'undefined' ? !!config.global.allowBooks : true;
  const allowAudiobooks = config.global && typeof config.global.allowAudiobooks !== 'undefined' ? !!config.global.allowAudiobooks : true;

  const filtered = scored.filter(m => {
    const isAudio = (m.type === 'audiobook' || (m.format && m.format === 'audiobook')) ? true : false;
    if (isAudio && !allowAudiobooks) return false;
    if (!isAudio && !allowBooks) return false;
    return true;
  });

  const thresholdPct = (config.global && typeof config.global.similarityThreshold === 'number') ? config.global.similarityThreshold : 0;
  const threshold = Math.max(0, Math.min(100, thresholdPct)) / 100;

  const byProviderAll = filtered.reduce((acc, m) => {
    (acc[m._provider] = acc[m._provider] || []).push(m);
    return acc;
  }, {});

  const cappedByProvider = {};
  for (const [providerName, matches] of Object.entries(byProviderAll)) {
    const providerCfg = (config.providers && config.providers[providerName]) || {};
    const max = typeof providerCfg.maxResults === 'number' ? providerCfg.maxResults : 0;
    let sorted = matches.slice().sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
    if (max > 0) sorted = sorted.slice(0, max);
    cappedByProvider[providerName] = sorted;
  }

  const capped = Object.values(cappedByProvider).flat();

  const candidates = capped.filter(m => (typeof m.similarity === 'number') ? (m.similarity >= threshold) : false);

  const byProvider = candidates.reduce((acc, m) => {
    (acc[m._provider] = acc[m._provider] || []).push(m);
    return acc;
  }, {});

  // Log candidate counts and planned full-metadata fetches
  try {
    const candidateCounts = {};
    let plannedFetches = 0;
    for (const [prov, arr] of Object.entries(byProvider)) {
      candidateCounts[prov] = arr.length;
      plannedFetches += arr.filter(i => !i._fullFetched).length;
    }
    console.log('[search] candidates:', JSON.stringify(candidateCounts), 'plannedFullFetches=', plannedFetches);
  } catch (e) { /* ignore logging errors */ }

  const fullFetchPromises = Object.entries(byProvider).map(async ([providerName, matches]) => {
    const providerObj = providers.find(p => p.name === providerName);
    if (!providerObj) return [];
    const inst = providerObj.instance;
    const limit = (config.providers && config.providers[providerName] && config.providers[providerName].concurrency) || 5;
    const toFetch = matches.filter(m => !m._fullFetched);

    if (typeof inst.mapWithConcurrency === 'function') {
      try {
        const results = await inst.mapWithConcurrency(toFetch, async (match) => {
          try {
            if (typeof inst.getFullMetadata === 'function') {
              return await inst.getFullMetadata(match);
            }
            return match;
          } catch (err) {
            console.error(`Error fetching metadata for provider ${providerName}:`, err && err.message ? err.message : err);
            return null;
          }
        }, limit);
        const fetched = results.filter(Boolean);
        const alreadyFull = matches.filter(m => m._fullFetched);
        return [...alreadyFull, ...fetched];
      } catch (err) {
        console.error(`Error in mapWithConcurrency for provider ${providerName}:`, err && err.message ? err.message : err);
        return matches;
      }
    }

    // Fallback: sequential fetches
    const out = [];
    for (const m of matches.filter(m => m._fullFetched)) out.push(m);
    for (const match of toFetch) {
      try {
        if (typeof inst.getFullMetadata === 'function') {
          const full = await inst.getFullMetadata(match);
          if (full) out.push(full);
        } else {
          out.push(match);
        }
      } catch (err) {
        console.error(`Error fetching metadata for provider ${providerName}:`, err && err.message ? err.message : err);
      }
    }
    return out;
  });

  const nested = await Promise.all(fullFetchPromises);
  const fullResults = nested.flat();

  // Sort final results
  fullResults.sort((a, b) => {
    if (b.similarity !== a.similarity) return b.similarity - a.similarity;
    const aIsAudio = (a.type === 'audiobook' || (a.format && a.format === 'audiobook')) ? 1 : 0;
    const bIsAudio = (b.type === 'audiobook' || (b.format && b.format === 'audiobook')) ? 1 : 0;
    if (bIsAudio !== aIsAudio) return bIsAudio - aIsAudio;
    const aPriority = typeof a._providerPriority === 'number' ? a._providerPriority : 0;
    const bPriority = typeof b._providerPriority === 'number' ? b._providerPriority : 0;
    return bPriority - aPriority;
  });

  // Optionally create a merged "best result" at the top
  try {
    const mergeEnabled = config.global && !!config.global.mergeBestResults;
    if (mergeEnabled && fullResults && fullResults.length) {
      const topSim = fullResults[0].similarity || 0;
      const EPS = 1e-6;
      const topGroup = fullResults.filter(fr => Math.abs((fr.similarity || 0) - topSim) <= EPS);
      if (topGroup.length > 1) {
        const countNonEmpty = (item) => {
          const fields = ['title','authors','narrator','description','cover','type','url','id','languages','publisher','publishedDate','series','genres','tags','identifiers'];
          let c = 0;
          for (const f of fields) if (item[f]) c++;
          return c;
        };

        const sortedGroup = topGroup.slice().sort((a, b) => {
          const pa = typeof a._providerPriority === 'number' ? a._providerPriority : 0;
          const pb = typeof b._providerPriority === 'number' ? b._providerPriority : 0;
          if (pb !== pa) return pb - pa;
          return countNonEmpty(b) - countNonEmpty(a);
        });

        const prefs = (config.global && config.global.mergePreferences) || {};

        const hasField = (item, field) => {
          if (!item) return false;
          if (field === 'language') return Array.isArray(item.languages) && item.languages.length;
          if (field === 'identifiers') return item.identifiers && Object.keys(item.identifiers).length > 0;
          const v = item[field];
          if (Array.isArray(v)) return v.length > 0;
          return (typeof v !== 'undefined' && v !== null && v !== '');
        };

        const getFieldValue = (item, field) => {
          if (!item) return undefined;
          if (field === 'language') return Array.isArray(item.languages) && item.languages.length ? item.languages[0] : undefined;
          return item[field];
        };

        const pickFieldAndSource = (field) => {
          const preferred = prefs && prefs[field];
          if (preferred) {
            const p = sortedGroup.find(i => i._provider === preferred && hasField(i, field));
            if (p) return { value: getFieldValue(p, field), source: preferred };
          }
          const contributor = sortedGroup.find(i => hasField(i, field));
          if (contributor) return { value: getFieldValue(contributor, field), source: contributor._provider };
          return { value: undefined, source: null };
        };

        const pickIdentifierAndSource = (key) => {
          const preferred = prefs && prefs['identifiers'];
          if (preferred) {
            const p = sortedGroup.find(i => i._provider === preferred && i.identifiers && i.identifiers[key]);
            if (p) return { value: p.identifiers[key], source: preferred };
          }
          for (const it of sortedGroup) {
            if (it.identifiers && it.identifiers[key]) return { value: it.identifiers[key], source: it._provider };
          }
          return { value: undefined, source: null };
        };

        const pickLanguageAndSource = () => {
          const preferred = prefs && prefs['language'];
          if (preferred) {
            const p = sortedGroup.find(i => i._provider === preferred && Array.isArray(i.languages) && i.languages.length);
            if (p) return { value: p.languages[0], source: preferred };
          }
          for (const it of sortedGroup) {
            if (Array.isArray(it.languages) && it.languages.length) return { value: it.languages[0], source: it._provider };
          }
          return { value: undefined, source: null };
        };

        const coverPick = pickFieldAndSource('cover');
        let coverValue = coverPick.value;
        let coverSource = coverPick.source;
        if (!coverValue) {
          const audioCandidate = sortedGroup.find(i => (i.type === 'audiobook' || (i.format && i.format === 'audiobook')) && i.cover);
          if (audioCandidate) {
            coverValue = audioCandidate.cover;
            coverSource = audioCandidate._provider;
          }
        }

        const merged = {};
        const titlePick = pickFieldAndSource('title'); merged.title = titlePick.value || '';
        const subtitlePick = pickFieldAndSource('subtitle'); merged.subtitle = subtitlePick.value || '';
        const authorsPick = pickFieldAndSource('authors'); merged.authors = authorsPick.value || [];
        const narratorPick = pickFieldAndSource('narrator'); merged.narrator = narratorPick.value || '';
        const descriptionPick = pickFieldAndSource('description'); merged.description = descriptionPick.value || '';
        merged.cover = coverValue || null;
        merged.type = (pickFieldAndSource('type').value) || (topGroup.some(i => i.type === 'audiobook') ? 'audiobook' : 'book');
        merged.similarity = topSim;

        merged.id = (pickFieldAndSource('id').value) || pickIdentifierAndSource('lubimyczytac').value || pickIdentifierAndSource('audioteka').value || '';
        merged.url = (pickFieldAndSource('url').value) || '';
        merged.source = pickFieldAndSource('source').value || null;

        const langs = new Set();
        for (const it of sortedGroup) {
          if (Array.isArray(it.languages)) for (const L of it.languages) langs.add(L);
        }
        merged.languages = Array.from(langs);

        const pickPublishedDate = () => {
          const preferred = prefs && prefs['publishedDate'];
          if (preferred) {
            const p = sortedGroup.find(i => i._provider === preferred && i.publishedDate);
            if (p) return { value: p.publishedDate, source: preferred };
          }
          for (const it of sortedGroup) {
            if (it.publishedDate) return { value: it.publishedDate, source: it._provider };
          }
          return { value: undefined, source: null };
        };

        const pubDatePick = pickPublishedDate();
        merged.publishedDate = pubDatePick.value || undefined;

        const pickPublishedYear = () => {
          const preferred = prefs && prefs['publishedYear'];
          if (preferred) {
            const p = sortedGroup.find(i => i._provider === preferred && (i.publishedDate || i.publishedYear));
            if (p) {
              if (p.publishedDate) return { value: (new Date(p.publishedDate).getFullYear() || '').toString(), source: preferred };
              if (p.publishedYear) return { value: (p.publishedYear || '').toString(), source: preferred };
            }
          }
          for (const it of sortedGroup) {
            if (it.publishedDate) {
              const y = new Date(it.publishedDate).getFullYear();
              if (y) return { value: y.toString(), source: it._provider };
            }
          }
          for (const it of sortedGroup) {
            if (it.publishedYear) return { value: (it.publishedYear || '').toString(), source: it._provider };
          }
          return { value: undefined, source: null };
        };

        const pubYearPick = pickPublishedYear();
        merged.publishedYear = pubYearPick.value || undefined;
        merged._mergedFieldSources = merged._mergedFieldSources || {};
        if (pubDatePick.source) merged._mergedFieldSources.publishedDate = pubDatePick.source;
        if (pubYearPick.source) merged._mergedFieldSources.publishedYear = pubYearPick.source;
        merged.publisher = pickFieldAndSource('publisher').value || '';
        merged.rating = pickFieldAndSource('rating').value || null;

        // series
        const seriesPref = prefs && prefs['series'];
        let chosenSeries = '';
        let seriesIndex = null;
        if (seriesPref) {
          const p = sortedGroup.find(i => i._provider === seriesPref && (i.series || (Array.isArray(i.series) && i.series.length)));
          if (p) {
            if (Array.isArray(p.series)) {
              const first = p.series[0];
              chosenSeries = (first && typeof first === 'object') ? (first.series || '') : (first || '');
              if (!seriesIndex && first && typeof first === 'object' && first.sequence) seriesIndex = first.sequence;
            } else {
              chosenSeries = p.series || '';
            }
            if (seriesIndex === null && typeof p.seriesIndex !== 'undefined') seriesIndex = p.seriesIndex;
          }
        }
        if (!chosenSeries) {
          const seriesSet = new Set();
          for (const it of sortedGroup) {
            if (Array.isArray(it.series)) {
              for (const s of it.series) {
                if (!s) continue;
                if (typeof s === 'object') { if (s.series) seriesSet.add(s.series); }
                else seriesSet.add(s);
              }
            } else if (it.series) {
              seriesSet.add(it.series);
            }
            if (!seriesIndex && (typeof it.seriesIndex !== 'undefined' && it.seriesIndex !== null)) seriesIndex = it.seriesIndex;
          }
          const seriesArr = Array.from(seriesSet);
          chosenSeries = seriesArr.length ? seriesArr[0] : '';
        }
        if (chosenSeries) {
          merged.series = [{ series: chosenSeries, sequence: (seriesIndex !== null && typeof seriesIndex !== 'undefined') ? String(seriesIndex) : undefined }];
        } else {
          merged.series = undefined;
        }
        merged.seriesIndex = (typeof seriesIndex !== 'undefined' && seriesIndex !== null) ? seriesIndex : null;

        const isbnPick = pickIdentifierAndSource('isbn'); merged.isbn = isbnPick.value || undefined;
        const asinPick = pickIdentifierAndSource('asin'); merged.asin = asinPick.value || undefined;
        const durationPick = pickFieldAndSource('duration'); merged.duration = durationPick.value || undefined;
        merged.url = merged.url || '';
        const languagePick = pickLanguageAndSource(); merged.language = languagePick.value || undefined;

        const normalize = (s) => (s || '').toString().trim().toLowerCase();
        const pickListPrefOrUnion = (field) => {
          const preferredProvider = prefs && prefs[field];
          if (preferredProvider) {
            const p = sortedGroup.find(i => i._provider === preferredProvider && Array.isArray(i[field]) && i[field].length);
            if (p) return p[field].slice();
          }
          const set = new Set();
          for (const it of sortedGroup) {
            if (Array.isArray(it[field])) for (const v of it[field]) {
              const n = normalize(v);
              if (n) set.add(n);
            }
          }
          return Array.from(set);
        };

        merged.genres = pickListPrefOrUnion('genres');
        merged.tags = pickListPrefOrUnion('tags');

        merged._mergedFieldSources = merged._mergedFieldSources || {};
        merged._mergedFieldSources.genres = (prefs && prefs['genres']) ? prefs['genres'] : Array.from(new Set(sortedGroup.filter(i => (i.genres && i.genres.length) || (typeof i.genres === 'string' && i.genres)).map(i => i._provider)));
        merged._mergedFieldSources.tags = (prefs && prefs['tags']) ? prefs['tags'] : Array.from(new Set(sortedGroup.filter(i => (i.tags && i.tags.length) || (typeof i.tags === 'string' && i.tags)).map(i => i._provider)));
        merged._mergedFieldSources.series = (prefs && prefs['series']) ? prefs['series'] : Array.from(new Set(sortedGroup.filter(i => (i.series && (Array.isArray(i.series) ? i.series.length : !!i.series))).map(i => i._provider)));

        const identifiers = {};
        for (const it of sortedGroup) {
          if (it.identifiers && typeof it.identifiers === 'object') {
            for (const [k, v] of Object.entries(it.identifiers)) {
              if (!identifiers[k] && v) identifiers[k] = v;
            }
          }
        }
        merged.identifiers = identifiers;

        merged._mergedFrom = topGroup.map(i => ({ provider: i._provider, id: i.id || i._id || null }));
        merged._mergedFieldSources = merged._mergedFieldSources || {};
        const singleFields = ['narrator','publisher','language','subtitle','duration','url','source'];
        for (const f of singleFields) {
          const pref = prefs && prefs[f];
          if (pref) {
            const p = sortedGroup.find(i => i._provider === pref && (i[f] || (f==='language' && i.languages && i.languages.length)));
            if (p) merged._mergedFieldSources[f] = pref;
            else {
              const contributor = sortedGroup.find(i => i[f] || (f==='language' && i.languages && i.languages.length));
              if (contributor) merged._mergedFieldSources[f] = contributor._provider;
            }
          } else {
            const contributor = sortedGroup.find(i => i[f] || (f==='language' && i.languages && i.languages.length));
            if (contributor) merged._mergedFieldSources[f] = contributor._provider;
          }
        }

        if (config.global && config.global.mergeDebug) {
          try {
            console.log('mergeBestResults topGroup providers:', topGroup.map(t => ({ provider: t._provider, priority: t._providerPriority, fields: Object.keys(t).filter(k => !!t[k]) })));
            console.log('mergeBestResults merged:', merged);
          } catch (e) { /* ignore */ }
        }
        try {
          if (merged && merged._mergedFieldSources) {
            console.log('[merge] merged from providers:', Array.from(new Set(topGroup.map(i => i._provider))).join(','), 'fieldSources=', JSON.stringify(merged._mergedFieldSources));
          } else {
            console.log('[merge] merged from providers:', Array.from(new Set(topGroup.map(i => i._provider))).join(','));
          }
        } catch (e) { /* ignore */ }

        merged._provider = 'merged';
        merged._providerPriority = (Math.max(...topGroup.map(i => (typeof i._providerPriority === 'number' ? i._providerPriority : 0))) || 0) + 1;
        merged.source = merged.source || { id: 'merged', description: 'Merged result' };

        const top = fullResults[0];
        const sameTitleAuthors = top.title === merged.title && top.authors && merged.authors && top.authors.join('|') === merged.authors.join('|');
        const mergedFields = ['narrator', 'description', 'cover', 'languages', 'identifiers', 'genres', 'tags'];
        const topHasAllMergedFields = mergedFields.every(f => {
          if (!merged[f] || (Array.isArray(merged[f]) && merged[f].length === 0)) return true;
          if (Array.isArray(merged[f])) return Array.isArray(top[f]) && top[f].length > 0;
          if (f === 'identifiers') return top[f] && Object.keys(top[f]).length > 0;
          return !!top[f];
        });
        if (!(sameTitleAuthors && topHasAllMergedFields)) {
          fullResults.unshift(merged);
        }
      }
    }
  } catch (err) {
    console.error('Error during mergeBestResults:', err && err.message ? err.message : err);
  }

  // Normalize author fields
  const normalizeAuthors = (item) => {
    if (!item) return;
    if (Array.isArray(item.authors)) {
      item.authors = item.authors.map(a => (a || '').toString().trim()).filter(Boolean);
    } else if (item.author && typeof item.author === 'string') {
      const parts = item.author.split(/\s*(?:,|;| and )\s*/).map(s => s.trim()).filter(Boolean);
      item.authors = parts;
    } else {
      item.authors = item.authors || [];
    }
    if (!item.author || typeof item.author !== 'string' || !item.author.trim()) {
      item.author = item.authors && item.authors.length ? item.authors.join(', ') : undefined;
    } else {
      item.author = item.author.trim();
    }
  };

  for (const it of fullResults) normalizeAuthors(it);

  for (const it of fullResults) {
    if ((!it.subtitle || it.subtitle === '') && it.identifiers && it.identifiers.title) {
      it.subtitle = it.identifiers.title;
    }
  }

  for (const it of fullResults) {
    if (!it.published) {
      if (it.publishedYear) it.published = it.publishedYear;
      else if (it.publishedDate) {
        try {
          const y = new Date(it.publishedDate).getFullYear();
          if (y && !Number.isNaN(y)) it.published = y.toString();
        } catch (e) { /* ignore */ }
      }
    }
    if (!it.published_date && it.publishedDate) it.published_date = it.publishedDate;
  }

  // Normalize series field to ABS format: [{ series: string, sequence: string }]
  for (const it of fullResults) {
    if (it._provider === 'merged') continue;
    if (it.series && !Array.isArray(it.series)) {
      it.series = [{
        series: it.series,
        sequence: (it.seriesIndex !== null && typeof it.seriesIndex !== 'undefined')
          ? String(it.seriesIndex)
          : undefined
      }];
    }
  }

  // Uzupełnij brakującego narratora z innych providerów
  for (const it of fullResults) {
    if (it.narrator) continue;
    const donor = fullResults.find(other =>
      other !== it &&
      other.narrator &&
      other.authors && it.authors &&
      other.authors[0] === it.authors[0] &&
      stringSimilarity.compareTwoStrings(
        (other.title || '').toLowerCase(),
        (it.title || '').toLowerCase()
      ) >= 0.7
    );
    if (donor) it.narrator = donor.narrator;
  }

  res.json({ providers: all, matches: fullResults });
});

function checkAdmin(req, res, next) {
  return next();
}

app.get('/admin/config', checkAdmin, (req, res) => {
  res.json(config);
});

app.get('/admin/providers/meta', checkAdmin, (req, res) => {
  const meta = providers.map(p => {
    const supported = (p.ProviderClass && p.ProviderClass.supportedLanguages) || [];
    return { name: p.name, supportedLanguages: supported };
  });
  res.json(meta);
});

app.put('/admin/config', checkAdmin, express.json(), (req, res) => {
  try {
    const newCfg = req.body;
    configLoader.saveConfig(newCfg);
    config = configLoader.loadConfig();
    try {
      reloadProviders(config);
    } catch (err) {
      console.error('Error reloading providers after config save:', err && err.message ? err.message : err);
    }
    console.log('Config saved. global.titleWeight=', (config.global && config.global.titleWeight));
    res.json({ ok: true, config });
  } catch (err) {
    res.status(400).json({ error: err.message, details: err.details || null });
  }
});

app.get('/admin', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'admin.html'));
});

app.get('/search-ui', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'search.html'));
});

app.listen(port, () => console.log(`Backbone listening on ${port}; providers: ${providers.map(p => p.name).join(',')}`));
