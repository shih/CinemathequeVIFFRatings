// ==UserScript==
// @name         TheCinematheque.ca & VIFF Ratings – Douban, IMDb & Letterboxd
// @namespace    http://tampermonkey.net/
// @version      1.04
// @description  Displays Letterboxd, IMDb and Douban ratings on VIFF and The Cinematheque film pages
// @author       ziban
// @match        https://viff.org/whats-on/*/
// @match        https://thecinematheque.ca/films/*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      movie.douban.com
// @connect      www.douban.com
// @connect      search.douban.com
// @connect      api.douban.com
// @connect      letterboxd.com
// @connect      v3.sg.media-imdb.com
// @connect      graphql.imdb.com
// @connect      www.imdb.com
// @license      MIT
// @downloadURL https://update.greasyfork.org/scripts/567317/TheCinemathequeca%20%20VIFF%20Ratings%20%E2%80%93%20Douban%2C%20IMDb%20%20Letterboxd.user.js
// @updateURL https://update.greasyfork.org/scripts/567317/TheCinemathequeca%20%20VIFF%20Ratings%20%E2%80%93%20Douban%2C%20IMDb%20%20Letterboxd.meta.js
// ==/UserScript==

(function () {
    'use strict';

    // ─── Styles ────────────────────────────────────────────────────────────────

    GM_addStyle(`
        #tc-ratings-widget {
            display: inline-flex;
            align-items: center;
            gap: 20px;
            margin: 10px 0 14px;
            padding: 10px 16px;
            background: #f2f2f2;
            border-radius: 8px;
            font-family: inherit;
        }
        #tc-ratings-widget .tc-rating-item {
            display: flex;
            align-items: center;
            gap: 7px;
            text-decoration: none;
            color: inherit;
        }
        #tc-ratings-widget .tc-rating-item:hover .tc-score {
            opacity: 0.75;
        }
        #tc-ratings-widget .tc-site-label {
            font-size: 13px;
            font-weight: 600;
            color: #555;
        }
        #tc-ratings-widget .tc-score {
            font-size: 17px;
            font-weight: 800;
            color: #e05c00;
        }
        #tc-ratings-widget .tc-score.tc-loading {
            font-size: 13px;
            font-weight: 400;
            color: #999;
            animation: tc-pulse 1.2s infinite;
        }
        #tc-ratings-widget .tc-score.tc-na {
            font-size: 13px;
            font-weight: 600;
            color: #e05c00;
            text-decoration: underline;
            text-underline-offset: 2px;
        }
        #tc-ratings-widget .tc-divider {
            width: 1px;
            height: 22px;
            background: #ccc;
        }
        @keyframes tc-pulse {
            0%, 100% { opacity: 1; }
            50%       { opacity: 0.4; }
        }
        /* Cinematheque: floating widget */
        body.tc-floating #tc-ratings-widget {
            position: fixed;
            top: 75px;
            left: 60px;
            z-index: 99999;
            margin: 0;
            box-shadow: 0 2px 8px rgba(0,0,0,0.15);
            backdrop-filter: blur(4px);
            background: rgba(242, 242, 242, 0.95);
        }
    `);

    // ─── Helpers ───────────────────────────────────────────────────────────────

    function gmFetch(url, { headers = {}, anonymous = false } = {}) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                anonymous,
                headers: {
                    'User-Agent': navigator.userAgent,
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                    ...headers,
                },
                timeout: 20000,
                onload:    resolve,
                onerror:   reject,
                ontimeout: () => reject(new Error('Timeout: ' + url)),
            });
        });
    }

    function parseHTML(html) {
        return new DOMParser().parseFromString(html, 'text/html');
    }


    // ─── Film info extraction ──────────────────────────────────────────────────

    function getFilmInfo() {
        const host = location.hostname;
        let rawTitle, releaseYear = null, director = null, akaTitle = null;

        if (host === 'thecinematheque.ca') {
            // Title: "The Cinematheque / Film Name"
            const titleParts = document.title.split(' / ');
            rawTitle = titleParts[titleParts.length - 1].trim();

            // Year, director, aka title: from film-detail <ul> whose <li>s have no <a> children
            const yearRe = /((?:19|20)\d{2})/;
            for (const ul of document.querySelectorAll('ul')) {
                const lis = [...ul.querySelectorAll(':scope > li')];
                if (lis.length < 3) continue;
                if (lis[0].querySelector('a')) continue;

                // Alternate title: either "aka ..." or a plain second title
                // The <li> at index 1 is an alt title if it's not a year/country,
                // runtime, rating, or aka-prefixed line
                for (const li of lis.slice(1, 3)) {
                    const txt = li.textContent.replace(/\s+/g, ' ').trim();
                    const akaMatch = txt.match(/^aka\s+(.+)$/i);
                    if (akaMatch) { akaTitle = akaMatch[1].trim(); break; }
                    // Plain alternate title: no year, no runtime, no rating pattern
                    if (yearRe.test(txt)) break;                              // hit year/country — stop
                    if (/^\d+\s*(min|DCP|Blu|mm)/i.test(txt)) break;
                    if (/^(NR|G|PG|14A|18A|R|AA|NC-17)$/i.test(txt)) break;
                    // It's a plain text name — treat as alternate title
                    if (txt.length > 1) { akaTitle = txt; break; }
                }

                // Extract year
                for (const li of lis.slice(1, 5)) {
                    const m = li.textContent.replace(/\s+/g, ' ').trim().match(yearRe);
                    if (m) { releaseYear = m[1]; break; }
                }

                // Director: the <li> right after the year/country <li> (typically index 3)
                // It's a plain-text name, not matching year, runtime, or rating patterns
                for (const li of lis.slice(2, 6)) {
                    const txt = li.textContent.replace(/\s+/g, ' ').trim();
                    if (yearRe.test(txt)) continue;                    // year/country line
                    if (/^\d+\s*(min|DCP|Blu|mm)/i.test(txt)) continue; // runtime line
                    if (/^(NR|G|PG|14A|18A|R|AA|NC-17)$/i.test(txt)) continue; // rating
                    if (/^aka\s/i.test(txt)) continue;                 // aka line
                    if (txt.length > 1 && txt.length < 80 && /^[A-Z\u00C0-\u024F]/.test(txt)) {
                        director = txt;
                        break;
                    }
                }

                if (releaseYear) break;
            }
        } else {
            // VIFF: title from <h1>, year from labeled "Year" field
            const h1 = document.querySelector('h1');
            rawTitle = h1 ? h1.textContent.trim() : document.title.split(' | ')[0].trim();

            for (const el of document.querySelectorAll('*')) {
                if (el.children.length > 0) continue;
                if (el.textContent.trim() === 'Year') {
                    const next = el.nextElementSibling;
                    if (next) {
                        const m = next.textContent.trim().match(/^((?:19|20)\d{2})$/);
                        if (m) { releaseYear = m[1]; break; }
                    }
                    const parentNext = el.parentElement?.nextElementSibling;
                    if (parentNext) {
                        const m = parentNext.textContent.trim().match(/((?:19|20)\d{2})/);
                        if (m) { releaseYear = m[1]; break; }
                    }
                }
            }
            if (!releaseYear) {
                const m = document.body.innerText.match(/\bYear\s*\n\s*((?:19|20)\d{2})\b/);
                if (m) releaseYear = m[1];
            }
        }

        // Normalize curly quotes/apostrophes to ASCII
        const title = (rawTitle || '')
            .replace(/[\u2018\u2019\u02BC]/g, "'")
            .replace(/[\u201C\u201D]/g, '"');
        if (akaTitle) {
            akaTitle = akaTitle
                .replace(/[\u2018\u2019\u02BC]/g, "'")
                .replace(/[\u201C\u201D]/g, '"');
        }

        return { title, releaseYear, director, akaTitle };
    }

    // ─── IMDb ─────────────────────────────────────────────────────────────────

    async function searchImdbSingle(query, year) {
        const q = encodeURIComponent(query);
        try {
            const res = await gmFetch(`https://v3.sg.media-imdb.com/suggestion/x/${q}.json`);
            if (res.status !== 200) return [];
            const data = JSON.parse(res.responseText);
            const results = data?.d || [];
            return results.filter(r => r.qid === 'movie' || r.qid === 'tvMovie');
        } catch (e) {
            return [];
        }
    }

    function dedupeMovies(movies) {
        const seen = new Set();
        return movies.filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; });
    }

    function yearClose(a, b) {
        return Math.abs(Number(a) - Number(b)) <= 1;
    }

    async function verifyDirector(imdbId, director) {
        // Use GraphQL to check director — avoids WAF bot-challenges on imdb.com
        try {
            const query = `query { title(id: "${imdbId}") { directors: credits(first: 5, filter: { categories: ["director"] }) { edges { node { name { nameText { text } } } } } } }`;
            const res = await new Promise((resolve, reject) => GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://graphql.imdb.com/',
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ query }),
                timeout: 20000,
                onload: resolve,
                onerror: reject,
                ontimeout: () => reject(new Error('Timeout')),
            }));
            if (res.status === 200) {
                const data = JSON.parse(res.responseText);
                const edges = data?.data?.title?.directors?.edges || [];
                const dirLower = director.toLowerCase();
                return edges.some(e => (e.node?.name?.nameText?.text || '').toLowerCase().includes(dirLower));
            }
        } catch {}
        return false;
    }

    async function searchImdb(title, year, { akaTitle = null, director = null } = {}) {
        const titles = [title];
        if (akaTitle) titles.push(akaTitle);

        // Round 1: fire all suggest queries in parallel (with-year + title-only)
        const queries = [];
        for (const t of titles) {
            queries.push(`${t}${year ? ' ' + year : ''}`);
            queries.push(t); // title-only for broader results
        }
        const batches = await Promise.all(queries.map(q => searchImdbSingle(q)));
        let allMovies = dedupeMovies(batches.flat());

        if (!allMovies.length) return null;

        // Build candidates: prefer exact year, then ±1 year, then all
        const exactYear = allMovies.filter(r => String(r.y) === String(year));
        const closeYear = year ? allMovies.filter(r => yearClose(r.y, year)) : allMovies;
        const candidates = exactYear.length ? exactYear
            : closeYear.length ? closeYear
            : allMovies;

        // Fast path: single exact-year match with no director to verify
        if (exactYear.length === 1 && !director) {
            const hit = exactYear[0];
            return { id: hit.id, title: hit.l, year: hit.y, url: `https://www.imdb.com/title/${hit.id}/` };
        }

        // If we have a director, verify candidates in parallel
        if (director) {
            // Combine exact-year and close-year candidates, deduped, up to 5
            const toVerify = dedupeMovies([...candidates, ...closeYear]).slice(0, 5);
            const results = await Promise.all(toVerify.map(hit => verifyDirector(hit.id, director).then(ok => ok ? hit : null)));
            const verified = results.find(r => r !== null);
            if (verified) {
                return { id: verified.id, title: verified.l, year: verified.y, url: `https://www.imdb.com/title/${verified.id}/` };
            }
        }

        const hit = candidates[0];
        return { id: hit.id, title: hit.l, year: hit.y, url: `https://www.imdb.com/title/${hit.id}/` };
    }

    async function getImdbRating(imdbId) {
        const filmUrl = `https://www.imdb.com/title/${imdbId}/`;

        // Primary: GraphQL API (fast, no WAF issues)
        try {
            const query = `query { title(id: "${imdbId}") { ratingsSummary { aggregateRating voteCount } } }`;
            const res = await new Promise((resolve, reject) => GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://graphql.imdb.com/',
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ query }),
                timeout: 20000,
                onload: resolve,
                onerror: reject,
                ontimeout: () => reject(new Error('Timeout')),
            }));
            if (res.status === 200) {
                const data = JSON.parse(res.responseText);
                const rv = data?.data?.title?.ratingsSummary?.aggregateRating;
                if (rv) return { rating: parseFloat(rv).toFixed(1), filmUrl };
            }
        } catch (e) {}

        // Fallback: scrape the page (may be blocked by WAF)
        try {
            const res = await gmFetch(filmUrl, { headers: { 'Accept-Language': 'en-US,en;q=0.9' } });
            if (res.status === 200) {
                const doc = parseHTML(res.responseText);
                for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
                    try {
                        const data = JSON.parse(script.textContent);
                        const rv = data?.aggregateRating?.ratingValue;
                        if (rv) return { rating: parseFloat(rv).toFixed(1), filmUrl };
                    } catch {}
                }
            }
        } catch (e) {}

        return { rating: null, filmUrl };
    }

    // ─── Douban ───────────────────────────────────────────────────────────────

    async function searchDouban(title, year) {
        // 1. Suggest API — query by title only, match by year in results
        try {
            const res = await gmFetch(`https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(title)}`);
            if (res.status === 200) {
                const results = JSON.parse(res.responseText);
                if (Array.isArray(results) && results.length > 0) {
                    const movies = results.filter(r => r.type === 'movie');
                    const hit = movies.find(r => String(r.year) === String(year))
                        || movies.find(r => yearClose(r.year, year));
                    if (hit) { return hit; }
                }
            }
        } catch (e) { }

        // 2. Full search fallback (obscure films not in suggest index)
        // Uses movie.douban.com/search which doesn't require login
        try {
            const searchUrl = `https://search.douban.com/movie/subject_search?search_text=${encodeURIComponent(year ? `${title} ${year}` : title).replace(/%20/g, "+")}&cat=1002`;
            const res = await gmFetch(searchUrl, { headers: { Referer: 'https://search.douban.com/' } });
            if (res.status !== 200) { return null; }

            const dataMatch = res.responseText.match(/window\.__DATA__\s*=\s*({.+?})\s*;<\/script>/s);
            if (dataMatch) {
                try {
                    const data = JSON.parse(dataMatch[1]);
                    const items = data?.payload?.items || data?.items || [];
                    const match = items.find(it => String(it.year) === String(year)) || items[0];
                    if (match?.id) {
                        return { id: match.id, url: `https://movie.douban.com/subject/${match.id}/`, year: match.year, title: match.title || title };
                    }
                } catch(e) {}
            }

            const html = res.responseText;
            const subjectRe = /movie\.douban\.com\/subject\/(\d+)/g;
            let m;
            const seen = new Set();
            const candidates = [];
            while ((m = subjectRe.exec(html)) !== null) {
                if (!seen.has(m[1])) { seen.add(m[1]); candidates.push(m[1]); }
            }

            const fetchCandidate = async (id) => {
                try {
                    const pageRes = await gmFetch(`https://movie.douban.com/subject/${id}/`, {
                        headers: { Referer: 'https://movie.douban.com/' }
                    });
                    if (pageRes.status !== 200) return null;
                    const yearM = pageRes.responseText.match(/<span class="year">\(((?:19|20)\d{2})\)<\/span>/);
                    const pageYear = yearM ? yearM[1] : null;
                    if (String(pageYear) !== String(year)) return null;
                    const doc = parseHTML(pageRes.responseText);
                    const ratingEl = doc.querySelector('strong.ll.rating_num, .rating_num');
                    const rating = ratingEl ? ratingEl.textContent.trim() : null;
                    const infoDiv = doc.querySelector('#info');
                    let imdbId = null;
                    if (infoDiv) {
                        const im = infoDiv.innerHTML.match(/\btt\d{7,8}\b/);
                        if (im) imdbId = im[0];
                    }
                    return { id, url: `https://movie.douban.com/subject/${id}/`, year: pageYear, title, _rating: rating, _imdbId: imdbId };
                } catch(e) { return null; }
            };

            const results2 = await Promise.all(candidates.slice(0, 5).map(fetchCandidate));
            const verified = results2.find(r => r !== null);
            if (verified) return verified;
        } catch (e) { }

        return null;
    }

    async function searchDoubanByImdb(imdbId) {
        // Douban V2 API — direct IMDb ID lookup, no login required
        try {
            const res = await new Promise((resolve, reject) => GM_xmlhttpRequest({
                method: 'POST',
                url: `https://api.douban.com/v2/movie/imdb/${imdbId}`,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf8' },
                data: 'apikey=0ab215a8b1977939201640fa14c66bab',
                timeout: 20000,
                onload: resolve,
                onerror: reject,
                ontimeout: () => reject(new Error('Timeout')),
            }));
            if (res.status === 200) {
                const data = JSON.parse(res.responseText);
                if (data?.alt && data.alt !== 'N/A') {
                    const url = data.alt.replace('/movie/', '/subject/') + '/';
                    const m = url.match(/subject\/(\d+)/);
                    const rating = data?.rating?.average || null;
                    if (m) { return { id: m[1], url, _rating: rating || undefined }; }
                }
            }
        } catch (e) { }
        return null;
    }

    async function getDoubanDetails(doubanId) {
        try {
            const res = await gmFetch(`https://movie.douban.com/subject/${doubanId}/`, {
                headers: { Referer: 'https://movie.douban.com/' },
            });
            if (res.status !== 200) return { rating: null, imdbId: null };
            const doc = parseHTML(res.responseText);
            const ratingEl = doc.querySelector('strong.ll.rating_num, .rating_num');
            const rating = ratingEl ? ratingEl.textContent.trim() : null;
            let imdbId = null;
            const infoDiv = doc.querySelector('#info');
            if (infoDiv) {
                const m = infoDiv.innerHTML.match(/\btt\d{7,8}\b/);
                if (m) imdbId = m[0];
            }
            return { rating, imdbId };
        } catch (e) {
            return { rating: null, imdbId: null };
        }
    }

    // ─── Letterboxd ───────────────────────────────────────────────────────────

    async function getLetterboxdRatingBySlug(slug) {
        const filmUrl = `https://letterboxd.com/film/${slug}/`;
        try {
            const res = await gmFetch(filmUrl);
            if (res.status !== 200) return { rating: null, filmUrl, imdbId: null };

            const doc = parseHTML(res.responseText);
            let rating = null;
            let imdbId = null;

            for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
                try {
                    const data = JSON.parse(script.textContent);
                    if (!rating) {
                        const rv = data?.aggregateRating?.ratingValue;
                        if (rv) rating = parseFloat(rv).toFixed(2);
                    }
                    if (!imdbId) {
                        const sameAs = [].concat(data?.sameAs || []);
                        const imdbUrl = sameAs.find(u => u.includes('imdb.com/title/'));
                        if (imdbUrl) {
                            const m = imdbUrl.match(/tt\d{7,8}/);
                            if (m) imdbId = m[0];
                        }
                    }
                } catch {}
            }

            if (!rating) {
                const twitterMeta = doc.querySelector('meta[name="twitter:data2"]');
                if (twitterMeta) {
                    const m = twitterMeta.getAttribute('content').match(/([\d.]+)/);
                    if (m) rating = parseFloat(m[1]).toFixed(2);
                }
            }

            return { rating, filmUrl, imdbId };
        } catch (e) {
            return { rating: null, filmUrl, imdbId: null };
        }
    }

    async function autocompleteLetterboxd(query, year = null) {
        try {
            const res = await gmFetch(`https://letterboxd.com/s/autocompletefilm?q=${encodeURIComponent(query)}&limit=10`);
            if (res.status !== 200) return null;
            const data = JSON.parse(res.responseText);
            const results = Array.isArray(data) ? data : (data.data || data.results || []);
            if (!results.length) return null;
            if (year) {
                const exactMatch = results.find(r => String(r.releaseYear) === String(year));
                if (exactMatch) return exactMatch;
                // ±1 year tolerance (Cinematheque may list local release year)
                const closeMatch = results.find(r => yearClose(r.releaseYear, year));
                return closeMatch || null;
            }
            return results[0];
        } catch (e) {
            return null;
        }
    }

    function slugFromHit(hit) {
        if (!hit) return null;
        if (hit.slug) return hit.slug;
        const url = hit.url || '';
        const m = url.match(/\/film\/([a-z0-9][a-z0-9-]*)\//);
        return m ? m[1] : null;
    }

    function slugFromUrl(url) {
        if (!url) return null;
        const m = url.match(/\/film\/([a-z0-9][a-z0-9-]*)\//);
        return m ? m[1] : null;
    }

    async function getLetterboxdByImdb(imdbId) {
        try {
            const res = await gmFetch(`https://letterboxd.com/imdb/${imdbId}/`);
            const slug = slugFromUrl(res.finalUrl || '');
            if (slug) return getLetterboxdRatingBySlug(slug);
        } catch (e) {}
        const hit = await autocompleteLetterboxd(imdbId);
        const slug = slugFromHit(hit);
        if (slug) return getLetterboxdRatingBySlug(slug);
        return { rating: null, filmUrl: null };
    }

    async function getLetterboxdBySearch(title, year) {
        const query = [title, year].filter(Boolean).join(' ');
        let hit = await autocompleteLetterboxd(query, year);
        if (!hit && year) {
            hit = await autocompleteLetterboxd(title);
        }
        const slug = slugFromHit(hit);
        if (slug) return getLetterboxdRatingBySlug(slug);
        return { rating: null, filmUrl: null };
    }

    // ─── UI ───────────────────────────────────────────────────────────────────

    function buildWidget() {
        const widget = document.createElement('div');
        widget.id = 'tc-ratings-widget';

        const doubanItem = document.createElement('a');
        doubanItem.className = 'tc-rating-item';
        doubanItem.target = '_blank';
        doubanItem.rel = 'noopener noreferrer';
        doubanItem.href = 'https://movie.douban.com';
        doubanItem.innerHTML = `
            <span class="tc-site-label">Douban:</span>
            <span class="tc-score tc-loading" id="tc-douban-score">loading…</span>
        `;

        const divider = document.createElement('div');
        divider.className = 'tc-divider';

        const imdbItem = document.createElement('a');
        imdbItem.className = 'tc-rating-item';
        imdbItem.target = '_blank';
        imdbItem.rel = 'noopener noreferrer';
        imdbItem.href = 'https://www.imdb.com';
        imdbItem.innerHTML = `
            <span class="tc-site-label">IMDb:</span>
            <span class="tc-score tc-loading" id="tc-imdb-score">loading…</span>
        `;

        const divider2 = document.createElement('div');
        divider2.className = 'tc-divider';

        const lbItem = document.createElement('a');
        lbItem.className = 'tc-rating-item';
        lbItem.target = '_blank';
        lbItem.rel = 'noopener noreferrer';
        lbItem.href = 'https://letterboxd.com';
        lbItem.innerHTML = `
            <span class="tc-site-label">Letterboxd:</span>
            <span class="tc-score tc-loading" id="tc-lb-score">loading…</span>
        `;

        widget.appendChild(lbItem);
        widget.appendChild(divider);
        widget.appendChild(imdbItem);
        widget.appendChild(divider2);
        widget.appendChild(doubanItem);

        if (location.hostname === 'thecinematheque.ca') {
            document.body.classList.add('tc-floating');
            document.body.appendChild(widget);
        } else {
            const h1 = document.querySelector('h1');
            if (h1 && h1.parentNode) {
                h1.parentNode.insertBefore(widget, h1.nextSibling);
            } else {
                document.body.prepend(widget);
            }
        }

        function applyState(el, linkEl, state, text, href, defaultHref) {
            el.classList.remove('tc-loading');
            el.textContent = text;
            if (state !== 'rating') el.classList.add('tc-na');
            linkEl.href = href || defaultHref;
        }

        return {
            setDouban(rating, url, fallbackSearchUrl, state = null) {
                const el = document.getElementById('tc-douban-score');
                if (!el) return;
                if (rating) {
                    applyState(el, doubanItem, 'rating', rating, url || fallbackSearchUrl, 'https://movie.douban.com');
                } else if (state === 'no-rating') {
                    applyState(el, doubanItem, 'no-rating', 'No ratings', url || fallbackSearchUrl, 'https://movie.douban.com');
                } else {
                    applyState(el, doubanItem, 'not-found', 'Not Found', fallbackSearchUrl || url, 'https://movie.douban.com');
                }
            },
            setImdb(rating, url, fallbackSearchUrl, state = null) {
                const el = document.getElementById('tc-imdb-score');
                if (!el) return;
                if (rating) {
                    applyState(el, imdbItem, 'rating', rating, url || fallbackSearchUrl, 'https://www.imdb.com');
                } else if (state === 'no-rating') {
                    applyState(el, imdbItem, 'no-rating', 'No ratings', url || fallbackSearchUrl, 'https://www.imdb.com');
                } else {
                    applyState(el, imdbItem, 'not-found', 'Not Found', fallbackSearchUrl || url, 'https://www.imdb.com');
                }
            },
            setLetterboxd(rating, url, fallbackSearchUrl, state = null) {
                const el = document.getElementById('tc-lb-score');
                if (!el) return;
                if (rating) {
                    applyState(el, lbItem, 'rating', rating, url || fallbackSearchUrl, 'https://letterboxd.com');
                } else if (state === 'no-rating') {
                    applyState(el, lbItem, 'no-rating', 'No ratings', url || fallbackSearchUrl, 'https://letterboxd.com');
                } else {
                    applyState(el, lbItem, 'not-found', 'Not Found', fallbackSearchUrl || url, 'https://letterboxd.com');
                }
            },
        };
    }

    // ─── Main ─────────────────────────────────────────────────────────────────

    async function main() {
        const host = location.hostname;
        const pathParts = window.location.pathname.replace(/^\/|\/$/g, '').split('/');
        if (host === 'viff.org') {
            if (pathParts.length !== 2 || pathParts[0] !== 'whats-on') return;
        } else if (host === 'thecinematheque.ca') {
            if (pathParts.length < 3) return;
        }

        const { title, releaseYear, director, akaTitle } = getFilmInfo();
        if (!title) return;

        // Use aka title for search URLs when available (it's typically the English title)
        const searchTitle = akaTitle || title;
        const doubanSearchUrl = `https://movie.douban.com/search/subject?search_text=${encodeURIComponent(searchTitle)}`;
        const imdbSearchUrl = `https://www.imdb.com/find/?q=${encodeURIComponent([searchTitle, releaseYear].filter(Boolean).join(' '))}&s=tt&ttype=ft`;
        const lbSearchUrl = `https://letterboxd.com/search/films/${encodeURIComponent([searchTitle, releaseYear].filter(Boolean).join(' '))}/`;

        const ui = buildWidget();

        function applyLb(lb) {
            if (lb.rating) {
                ui.setLetterboxd(lb.rating, lb.filmUrl, lbSearchUrl);
            } else if (lb.filmUrl) {
                ui.setLetterboxd(null, lb.filmUrl, lbSearchUrl, 'no-rating');
            } else {
                ui.setLetterboxd(null, null, lbSearchUrl, 'not-found');
            }
        }

        // All three platforms run independently and update the UI as soon as they resolve.
        // IMDb search result is shared via a promise so LB/Douban can use the IMDb ID if
        // their own title-based search is slower.

        let resolveImdbId;
        const imdbIdPromise = new Promise(r => { resolveImdbId = r; });

        // ── IMDb flow ──────────────────────────────────────────────────────
        const imdbFlow = (async () => {
            const imdbResult = await searchImdb(title, releaseYear, { akaTitle, director });
            const imdbId = imdbResult?.id || null;
            resolveImdbId(imdbId);     // unblock LB/Douban IMDb-based lookups

            if (!imdbId) {
                ui.setImdb(null, null, imdbSearchUrl, 'not-found');
                return;
            }
            const { rating } = await getImdbRating(imdbId);
            if (rating) {
                ui.setImdb(rating, imdbResult.url, imdbSearchUrl);
            } else {
                ui.setImdb(null, imdbResult.url, imdbSearchUrl, 'no-rating');
            }
        })();

        // ── Letterboxd flow ────────────────────────────────────────────────
        const lbFlow = (async () => {
            // Start title-based autocomplete immediately (no dependency)
            const lbQuery = [searchTitle, releaseYear].filter(Boolean).join(' ');
            const titleSearchP = autocompleteLetterboxd(lbQuery, releaseYear);

            // Also wait for IMDb ID to try the more reliable IMDb→LB redirect
            const imdbId = await imdbIdPromise;
            if (imdbId) {
                const lbResult = await getLetterboxdByImdb(imdbId);
                if (lbResult.rating || lbResult.filmUrl) { applyLb(lbResult); return; }
            }
            // Fall back to title-based search
            let hit = await titleSearchP;
            if (!hit) hit = await autocompleteLetterboxd(searchTitle);
            const slug = slugFromHit(hit);
            if (slug) {
                applyLb(await getLetterboxdRatingBySlug(slug));
            } else {
                applyLb({ rating: null, filmUrl: null });
            }
        })();

        // ── Douban flow ────────────────────────────────────────────────────
        const doubanFlow = (async () => {
            // Start title-based search immediately (no dependency)
            const titleSearchP = (async () => {
                if (akaTitle) {
                    const res = await searchDouban(akaTitle, releaseYear);
                    if (res) return res;
                }
                return searchDouban(title, releaseYear);
            })();

            // Also wait for IMDb ID to try the more reliable API lookup
            const imdbId = await imdbIdPromise;
            let source = imdbId ? await searchDoubanByImdb(imdbId) : null;
            if (!source) source = await titleSearchP;

            if (!source) {
                ui.setDouban(null, null, doubanSearchUrl, 'not-found');
                return;
            }
            const { rating } = source._rating !== undefined
                ? { rating: source._rating }
                : await getDoubanDetails(source.id);
            if (rating) {
                ui.setDouban(rating, source.url, doubanSearchUrl);
            } else {
                ui.setDouban(null, source.url, doubanSearchUrl, 'no-rating');
            }
        })();

        const mainFlow = Promise.all([imdbFlow, lbFlow, doubanFlow]);

        let workDone = false;
        mainFlow.finally(() => { workDone = true; });
        setTimeout(() => {
            if (!workDone) return;
            const dbEl = document.getElementById('tc-douban-score');
            if (dbEl && dbEl.classList.contains('tc-loading')) {
                ui.setDouban(null, null, doubanSearchUrl, 'not-found');
            }
            const lbEl = document.getElementById('tc-lb-score');
            if (lbEl && lbEl.classList.contains('tc-loading')) {
                ui.setLetterboxd(null, null, lbSearchUrl, 'not-found');
            }
        }, 30000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', main);
    } else {
        main();
    }

})();
