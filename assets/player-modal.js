// Player modal for the pickup report. Any element with class "player" and a
// data-name (plus data-team as a tiebreaker) opens a bottom sheet with ports
// of the Chrome extension's player-modal pieces
// (basketball/chrome-extension/content/player-modal.js, depth-chart.js,
// common.js):
//   - the 9-cat value chart (FantasyPros ROS, Per Game / Per Min toggle),
//     with each category's projected per-game stat under its bar
//   - the stats table (2 seasons ago .. this season, L90, L30, projections,
//     ending with SPS Live / SPS ROS)
//   - the player's latest ESPN news (same Rotowire feed as the extension)
//   - the team depth chart from the nightly projected playing time
//     (/api/playing-time), with a Live / ROS toggle, projected minutes plus
//     FantasyPros ROS FGA per player; tapping anyone on it opens their modal
// Everything is fetched live from the browser when the modal opens; the
// backend and site.api.espn.com both allow any origin.

(() => {
    const API_BASE_URL = 'https://i9708892i9.execute-api.us-west-1.amazonaws.com/prod';
    const ESPN_NEWS_URL = 'https://site.api.espn.com/apis/fantasy/v2/games/fba/news/players';
    const VALUE_WINDOW = 'fantasyProsRosProjection';
    const NEWS_ITEMS = 3;
    const STATS_FLAGS = [
        'statsTwoSeasonsAgo',
        'statsLastSeason',
        'statsCurrentSeason',
        'statsHashtagBasketballProjection',
        'statsFantasyProsRosProjection',
        'statsSpsLiveProjection',
        'statsSpsRosProjection',
        'statsLast90',
        'statsLast30',
    ];

    const CATS = [
        { key: 'pts', label: 'PTS', name: 'Points', color: '#0f9b7c', stat: 'pointsPerGame' },
        { key: 'fg', label: 'FG%', name: 'Field Goal %', color: '#2a78d6', stat: 'fieldGoalPct', att: 'fieldGoalsAttemptedPerGame' },
        { key: 'ft', label: 'FT%', name: 'Free Throw %', color: '#eb6834', stat: 'freeThrowPct', att: 'freeThrowsAttemptedPerGame' },
        { key: 'tpm', label: '3PM', name: 'Three-Pointers Made', color: '#1baf7a', stat: 'threePointersMadePerGame' },
        { key: 'reb', label: 'REB', name: 'Rebounds', color: '#eda100', stat: 'reboundsPerGame' },
        { key: 'ast', label: 'AST', name: 'Assists', color: '#008300', stat: 'assistsPerGame' },
        { key: 'stl', label: 'STL', name: 'Steals', color: '#e87ba4', stat: 'stealsPerGame' },
        { key: 'blk', label: 'BLK', name: 'Blocks', color: '#4a3aa7', stat: 'blocksPerGame' },
        { key: 'to', label: 'TO', name: 'Turnovers', color: '#e34948', stat: 'turnoversPerGame' },
    ];
    const MAX_DOLLAR = 15;

    // ---------- helpers ----------

    const escapeHtml = (text) =>
        String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const dollar = (n) => {
        const rounded = Math.round(n);
        return (rounded < 0 ? '-$' : '$') + Math.abs(rounded);
    };
    const fmt0 = (n) => Math.round(n ?? 0).toString();
    const fmt1 = (n) => (n ?? 0).toFixed(1);
    const pct2 = (n) => (n ?? 0).toFixed(2).replace(/^0\./, '.').replace(/^-0\./, '-.');
    const pct3 = (n) => (n ?? 0).toFixed(3).replace(/^0\./, '.');

    // common.js gradeColor/valueColor: muted gray at $0, full green from $70,
    // full red from -$10.
    function valueColor(n) {
        const [neutral, ceiling, floor] = [0, 70, -10];
        const intensity = n >= neutral ? Math.min((n - neutral) / (ceiling - neutral), 1) : Math.min((n - neutral) / (floor - neutral), 1);
        const mix = Math.round(intensity * 100) / 100;
        const target = n >= neutral ? [0x00, 0x63, 0x00] : [0xc0, 0x39, 0x2b];
        const muted = [0x88, 0x90, 0xa0];
        const [r, g, b] = target.map((c, i) => Math.round(c * mix + muted[i] * (1 - mix)));
        return `rgb(${r}, ${g}, ${b})`;
    }

    // Same as the backend's normalize_name() and the extension's normalizeName.
    const normalizeName = (name) =>
        (name || '')
            .normalize('NFKD')
            .replace(/[̀-ͯ]/g, '')
            .toLowerCase()
            .replace(/\./g, '')
            .trim()
            .replace(/\s+(jr|sr|ii|iii|iv|v)\.?$/, '')
            .replace(/\s+/g, ' ')
            .trim();
    // The backend's ?name= is a case-insensitive substring match without
    // accent folding, so search with the bare name and filter client-side.
    const searchName = (name) =>
        (name || '')
            .normalize('NFKD')
            .replace(/[̀-ͯ]/g, '')
            .replace(/\./g, '')
            .replace(/\s+(Jr|Sr|II|III|IV|V)$/i, '')
            .trim();

    // Report team codes are NBA tricodes, but accept Yahoo/ESPN short forms too.
    const TEAM_ALIASES = { GS: 'GSW', NO: 'NOP', NY: 'NYK', SA: 'SAS', PHO: 'PHX', UTAH: 'UTA', WSH: 'WAS', BRK: 'BKN', CHO: 'CHA' };
    const toTricode = (team) => TEAM_ALIASES[(team || '').toUpperCase()] ?? (team || '').toUpperCase();

    // Same as webapp utils/format.ts teamLogoUrl.
    const LOGO_SLUGS = { GSW: 'gs', NOP: 'no', NYK: 'ny', SAS: 'sa', UTA: 'utah', WAS: 'wsh' };
    const teamLogoUrl = (tricode) => `https://a.espncdn.com/i/teamlogos/nba/500/${LOGO_SLUGS[tricode] ?? tricode.toLowerCase()}.png`;
    const headshotUrl = (playerId) => `https://a.espncdn.com/i/headshots/nba/players/full/${playerId}.png`;
    function initials(name) {
        const parts = name.replace(/[^\w\s]/g, '').split(' ').filter(Boolean);
        return ((parts[0] ?? '')[0] ?? '') + ((parts[parts.length - 1] ?? '')[0] ?? '');
    }

    // data-fallback="remove" drops a missing logo; any other value replaces a
    // missing headshot with those initials.
    function wireImageFallbacks(root) {
        for (const img of root.querySelectorAll('img[data-fallback]')) {
            img.addEventListener('error', () => {
                const fallback = img.dataset.fallback;
                if (fallback === 'remove') img.remove();
                else img.replaceWith(Object.assign(document.createElement('span'), { textContent: fallback }));
            });
        }
    }

    // ---------- data (memoized per page load) ----------

    const memo = new Map();
    function cached(key, load) {
        if (!memo.has(key)) {
            const promise = load();
            memo.set(key, promise);
            promise.catch(() => memo.delete(key));
        }
        return memo.get(key);
    }

    async function getJson(url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${new URL(url).pathname} failed (${response.status})`);
        return response.json();
    }

    // Exact normalized name match, team as the tiebreaker (the extension's
    // buildPoolMatcher rule), falling back to a lone substring match.
    const fetchPlayer = (name, team) =>
        cached(`player|${normalizeName(name)}|${team}`, async () => {
            const url = `${API_BASE_URL}/api/players?pageSize=10&name=${encodeURIComponent(searchName(name))}&${STATS_FLAGS.join('&')}&categoryValue`;
            const players = (await getJson(url)).players ?? [];
            const exact = players.filter((p) => normalizeName(p.playerName) === normalizeName(name));
            const candidates = exact.length ? exact : players;
            if (candidates.length <= 1) return candidates[0] ?? null;
            return candidates.find((p) => p.team === toTricode(team)) ?? null;
        });

    // { team, live, ros }: the team's newest projected depth charts, with
    // ESPN injury fields on each entry.
    const fetchPlayingTime = (tricode) => cached(`playtime|${tricode}`, () => getJson(`${API_BASE_URL}/api/playing-time/${encodeURIComponent(tricode)}`));

    // playerId -> { min, fga } from the team's FantasyPros ROS projections;
    // the depth chart's "(32/14)" labels use only the FGA.
    const fetchTeamProjections = (tricode) =>
        cached(`teamproj|${tricode}`, async () => {
            const body = await getJson(`${API_BASE_URL}/api/players?pageSize=100&team=${encodeURIComponent(tricode)}&statsFantasyProsRosProjection`);
            const byId = new Map();
            for (const p of body.players ?? []) {
                const s = p.stats?.[VALUE_WINDOW];
                if (s) byId.set(p.playerId, { min: s.minutesPerGame, fga: s.fieldGoalsAttemptedPerGame });
            }
            return byId;
        });

    const fetchNews = (playerId) =>
        cached(`news|${playerId}`, async () => {
            const feed = (await getJson(`${ESPN_NEWS_URL}?playerId=${encodeURIComponent(playerId)}&limit=15`)).feed ?? [];
            // The feed mixes in highlight clips ("Media", headline only); keep the write-ups.
            return feed
                .filter((item) => item.type !== 'Media')
                .slice(0, NEWS_ITEMS)
                .map((item) => ({ headline: item.headline, story: item.story ?? item.description ?? '', published: item.published, source: item.type ?? '' }));
        });

    // ---------- 9-cat value ----------

    const VALUE_MODES = [
        { key: 'game', label: 'Per Game', suffix: 'L156R120B2400C9' },
        { key: 'min', label: 'Per Min', suffix: 'PerMinL156R120B2400C9' },
    ];
    let valueMode = 'game'; // remembered across modals until the page reloads

    function categoryValueFromStats(stats, suffix) {
        const total = stats?.[`auctionValueTotal${suffix}`];
        if (total == null) return null;
        const value = { total };
        for (const { key } of CATS) value[key] = stats[`auctionValue${key[0].toUpperCase()}${key.slice(1)}${suffix}`] ?? 0;
        return value;
    }

    // The extension's labeledChartSvg, plus (per game only) a row under the
    // labels with each category's projected per-game stat and FGA/FTA.
    function chartSvg(value, stats) {
        const CW = 460;
        const BASE_Y = 75;
        const BAR_W = 32;
        const GAP = 16;
        const MAX_H = 48;
        const LABEL_Y = 160;
        const STAT_Y = 180;
        const ATT_Y = 196;
        const CH = stats ? 206 : 168;
        const startX = (CW - (CATS.length * BAR_W + (CATS.length - 1) * GAP)) / 2;
        const bars = CATS.map((cat, i) => {
            const x = startX + i * (BAR_W + GAP);
            const cx = x + BAR_W / 2;
            const v = value[cat.key] ?? 0;
            const h = Math.max(Math.min(Math.abs(v) / MAX_DOLLAR, 1) * MAX_H, 3);
            const positive = v >= 0;
            const y = positive ? BASE_Y - h : BASE_Y;
            const amountY = positive ? y - 5 : y + h + 12;
            let statText = '';
            if (stats) {
                statText = `<text class="stat" x="${cx}" y="${STAT_Y}" text-anchor="middle">${cat.att ? pct3(stats[cat.stat]) : fmt1(stats[cat.stat])}</text>`;
                if (cat.att) statText += `<text class="att" x="${cx}" y="${ATT_Y}" text-anchor="middle">${fmt0(stats[cat.att])} att</text>`;
            }
            return `<g>
                <rect x="${x}" y="${y}" width="${BAR_W}" height="${h}" rx="4" fill="${cat.color}" opacity="${positive ? 1 : 0.5}"><title>${cat.name}: ${dollar(v)}</title></rect>
                <text class="amount${Math.round(v) < 0 ? ' neg' : ''}" x="${cx}" y="${amountY}" text-anchor="middle">${dollar(v)}</text>
                <text class="label" x="${cx}" y="${LABEL_Y}" text-anchor="middle">${cat.label}</text>${statText}
            </g>`;
        }).join('');
        const divider = stats ? `<line x1="${startX - 6}" y1="${LABEL_Y + 6}" x2="${CW - startX + 6}" y2="${LABEL_Y + 6}" class="divider" />` : '';
        return `<svg class="pm-chart" viewBox="0 0 ${CW} ${CH}" role="img" aria-label="9-category value">
            <line x1="${startX - 6}" y1="${BASE_Y}" x2="${CW - startX + 6}" y2="${BASE_Y}" class="baseline" />${divider}${bars}
        </svg>`;
    }

    function valueSectionHtml(player) {
        const stats = player.stats?.[VALUE_WINDOW];
        const toggle = VALUE_MODES.map(({ key, label }) => `<button type="button" data-mode="${key}">${label}</button>`).join('');
        const panes = VALUE_MODES.map(({ key, suffix }) => {
            const value = categoryValueFromStats(stats, suffix);
            const body = value ? chartSvg(value, key === 'game' ? stats : null) : '<div class="pm-empty">No FantasyPros ROS projection.</div>';
            const total = value ? ` &middot; <span class="pm-mono" style="color:${valueColor(value.total)};font-weight:800">${dollar(value.total)}</span> total` : '';
            return `<div data-pane="${key}"><div class="pm-pane-meta">FP ROS${total}</div>${body}</div>`;
        }).join('');
        return `<div class="pm-catvalue" data-mode="${valueMode}">
            <div class="pm-section-row"><h3>9-Cat Value</h3><div class="pm-segmented">${toggle}</div></div>${panes}
        </div>`;
    }

    function wireValueToggle(root) {
        const section = root.querySelector('.pm-catvalue');
        for (const button of section?.querySelectorAll('button[data-mode]') ?? []) {
            button.addEventListener('click', () => {
                valueMode = button.dataset.mode;
                section.dataset.mode = valueMode;
            });
        }
    }

    // ---------- stats table (port of the extension's tableHtml) ----------

    // Mirrors current_season_end_year()/season_label() (player-stats-sync).
    function seasonLabelYearsAgo(yearsAgo, now = new Date()) {
        const startYear = now.getUTCMonth() + 1 >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
        const endYear = startYear + 1 - yearsAgo;
        return `${endYear - 1}-${String(endYear).slice(-2)}`;
    }

    const ROWS = [
        { key: 'twoSeasonsAgo', short: seasonLabelYearsAgo(2) },
        { key: 'lastSeason', short: 'LAST SZN' },
        { key: 'currentSeason', short: 'THIS SZN' },
        { key: 'last90', short: 'L90' },
        { key: 'last30', short: 'L30' },
        { key: 'hashtagBasketballProjection', short: 'HASHTAG', projection: true },
        // GP on this row is projected games left, not a full season.
        { key: 'fantasyProsRosProjection', short: 'FP ROS', projection: true },
        // Basketball-Reference SPS per-36 rates x the nightly live/ros
        // projected minutes; GP is the team's games left.
        { key: 'spsLiveProjection', short: 'SPS LIVE', projection: true },
        { key: 'spsRosProjection', short: 'SPS ROS', projection: true },
    ];
    const COLUMNS = ['GP', 'MIN', 'PTS', 'FG%', 'FT%', '3PM', 'REB', 'AST', 'STL', 'BLK', 'TO', 'FPTS', 'VAL/MIN', 'VALUE'];

    const valueCell = (v) =>
        v == null ? '<td class="pm-mono pm-cell-value">&mdash;</td>' : `<td class="pm-mono pm-cell-value" style="color:${valueColor(v)}">${dollar(v)}</td>`;
    const pctCell = (pct, attempts) =>
        `<td class="pm-mono"><span class="pm-pct"><span>${pct2(pct)}</span><span class="pm-pct-att">${fmt0(attempts)}</span></span></td>`;

    function statCells(s, isProjection) {
        if (!s || s.gamesPlayed === 0) {
            // An SPS row at 0 GP is a player projected for 0 minutes.
            const message = !isProjection ? 'No games played in this window' : s ? '0 projected minutes' : 'No projection data available yet';
            return `<td colspan="${COLUMNS.length}" class="pm-empty-cell">${message}</td>`;
        }
        return [
            `<td class="pm-mono">${s.gamesPlayed}</td>`,
            `<td class="pm-mono">${fmt1(s.minutesPerGame)}</td>`,
            `<td class="pm-mono">${fmt1(s.pointsPerGame)}</td>`,
            pctCell(s.fieldGoalPct, s.fieldGoalsAttemptedPerGame),
            pctCell(s.freeThrowPct, s.freeThrowsAttemptedPerGame),
            `<td class="pm-mono">${fmt1(s.threePointersMadePerGame)}</td>`,
            `<td class="pm-mono">${fmt1(s.reboundsPerGame)}</td>`,
            `<td class="pm-mono">${fmt1(s.assistsPerGame)}</td>`,
            `<td class="pm-mono">${fmt1(s.stealsPerGame)}</td>`,
            `<td class="pm-mono">${fmt1(s.blocksPerGame)}</td>`,
            `<td class="pm-mono">${fmt1(s.turnoversPerGame)}</td>`,
            `<td class="pm-mono pm-cell-fpts">${fmt1(s.espnFantasyPointsPerGame)}</td>`,
            valueCell(s.auctionValueTotalPerMinL156R120B2400C9),
            valueCell(s.auctionValueTotalL156R120B2400C9),
        ].join('');
    }

    function teamBadges(teams) {
        if (!teams?.length) return '';
        return `<span class="pm-badges">${teams
            .map((t) => `<img class="pm-badge" src="${teamLogoUrl(t)}" alt="${escapeHtml(t)}" data-fallback="remove">`)
            .join('')}</span>`;
    }

    function statsTableHtml(player) {
        const byWindow = player.stats ?? {};
        const head = COLUMNS.map((c) => `<th>${c}</th>`).join('');
        // Hashtag only covers its free top 30; hide its row for everyone else.
        const rows = ROWS.filter((row) => row.key !== 'hashtagBasketballProjection' || byWindow[row.key] != null)
            .map((row) => {
                const s = byWindow[row.key] ?? null;
                const classes = [row.projection ? 'pm-row-proj' : '', s?.auctionValueQualifiedL156R120B2400C9 === false ? 'pm-row-unq' : ''].join(' ');
                const label = `${row.short}${row.projection ? '<span class="pm-proj-tag">PROJ</span>' : ''}${teamBadges(s?.teams)}`;
                return `<tr class="${classes}"><td class="pm-row-window">${label}</td>${statCells(s, row.projection)}</tr>`;
            })
            .join('');
        return `<div class="pm-section-row"><h3>Stats</h3><span class="pm-hint">scroll &rarr;</span></div>
            <div class="pm-scroll"><table class="pm-table"><thead><tr><th class="pm-th-window">Split</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
    }

    // ---------- news ----------

    // "Sat, Oct 24, 10:23 AM", like ESPN's Recent News.
    const newsTime = (iso) =>
        iso ? new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

    function newsHtml(items) {
        if (!items.length) return '<div class="pm-empty">No recent news.</div>';
        return items
            .map(
                (n) => `<article class="pm-news">
                    <div class="pm-news-meta"><span>${escapeHtml(newsTime(n.published))}</span><span>${escapeHtml(n.source)}</span></div>
                    <div class="pm-news-headline">${escapeHtml(n.headline)}</div>
                    ${n.story ? `<div class="pm-news-story">${escapeHtml(n.story.replace(/<[^>]+>/g, ''))}</div>` : ''}
                </article>`
            )
            .join('');
    }

    // ---------- depth chart (port of the extension's depthChartHtml) ----------

    const POSITION_ORDER = ['pg', 'sg', 'sf', 'pf', 'c'];
    const POSITION_LABELS = { pg: 'PG', sg: 'SG', sf: 'SF', pf: 'PF', c: 'C' };
    const COURT_CHIP_POSITION = {
        pg: { left: '50%', top: '19%' },
        sg: { left: '18%', top: '41%' },
        sf: { left: '82%', top: '41%' },
        pf: { left: '35%', top: '70%' },
        c: { left: '65%', top: '70%' },
    };
    const COURT_SVG = `
        <svg class="dc-court-svg" viewBox="0 0 480 600" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
            <rect x="14" y="14" width="452" height="572" rx="14" fill="var(--pm-court)" stroke="var(--pm-border-strong)" stroke-width="2" />
            <path d="M188,14 A52,52 0 0 0 292,14" fill="none" stroke="var(--pm-border-strong)" stroke-width="1.5" />
            <path d="M34,470 C34,300 130,182 240,182 C350,182 446,300 446,470" fill="none" stroke="var(--pm-border-strong)" stroke-width="1.5" />
            <line x1="34" y1="470" x2="34" y2="586" stroke="var(--pm-border-strong)" stroke-width="1.5" />
            <line x1="446" y1="470" x2="446" y2="586" stroke="var(--pm-border-strong)" stroke-width="1.5" />
            <rect x="188" y="420" width="104" height="166" fill="none" stroke="var(--pm-border-strong)" stroke-width="1.5" />
            <circle cx="240" cy="420" r="56" fill="none" stroke="var(--pm-border-strong)" stroke-width="1.5" stroke-dasharray="5 4" />
            <path d="M202,586 A38,38 0 0 1 278,586" fill="none" stroke="var(--pm-border-strong)" stroke-width="1.5" stroke-dasharray="4 4" />
            <rect x="212" y="562" width="56" height="4" fill="var(--pm-border-strong)" />
            <circle cx="240" cy="572" r="8" fill="none" stroke="var(--pm-accent)" stroke-width="3" />
        </svg>`;

    const isOut = (entry) => entry.injuryAbbreviation === 'O' || entry.injuryStatus === 'Out';
    const injuryClass = (entry) => (isOut(entry) ? 'out' : 'dtd');
    const avatarHtml = (entry, size) =>
        `<div class="dc-avatar dc-avatar-${size}"><img src="${headshotUrl(entry.playerId)}" alt="" data-fallback="${escapeHtml(initials(entry.playerName))}"></div>`;

    // Each player is itself a .player link, so tapping one opens their modal.
    const playerAttrs = (entry, tricode) => ` data-name="${escapeHtml(entry.playerName)}" data-team="${escapeHtml(tricode)}"`;

    // live: today's injured players stay out. ros: players expected back
    // this season are in. The sheet opens on Live every time.
    const DEPTH_VIEWS = [
        { key: 'live', label: 'Live', caption: 'current injuries stay out' },
        { key: 'ros', label: 'ROS', caption: 'injured players back when healthy' },
    ];

    // "(32/14)": projected minutes (this chart) / FantasyPros ROS FGA per
    // game, or "(32)" when FantasyPros has no line for the player.
    function projectionHtml(entry, projectionById) {
        const fga = projectionById.get(entry.playerId)?.fga;
        return ` <span class="dc-proj">(${fmt0(entry.mpg)}${fga != null ? `/${fmt0(fga)}` : ''})</span>`;
    }

    function depthChartHtml(playingTime, viewKey, subjectId, projectionById) {
        const tricode = playingTime.team;
        const view = DEPTH_VIEWS.find((v) => v.key === viewKey);
        const chart = playingTime[viewKey];
        const toggle = DEPTH_VIEWS.map(
            (v) => `<button type="button" data-view="${v.key}" class="${v.key === viewKey ? 'on' : ''}" aria-pressed="${v.key === viewKey}">${v.label}</button>`
        ).join('');
        const head = `<div class="pm-section-row"><h3>${escapeHtml(tricode)} Depth Chart</h3><div class="pm-segmented dc-view-toggle">${toggle}</div></div>`;
        if (!chart) return `${head}<div class="pm-empty">No ${view.label} projection for ${escapeHtml(tricode)} yet.</div>`;

        const chips = POSITION_ORDER.map((pos) => {
            const starter = chart.positions[pos]?.[0];
            if (!starter) return '';
            const { left, top } = COURT_CHIP_POSITION[pos];
            const injury = starter.injuryStatus ? `<div class="dc-chip-injury ${injuryClass(starter)}">${escapeHtml(starter.injuryStatus)}</div>` : '';
            return `<div class="dc-chip${starter.playerId === subjectId ? ' is-subject' : ''}" style="left:${left};top:${top}">
                <div class="dc-chip-inner player"${playerAttrs(starter, tricode)}>
                    ${avatarHtml(starter, 'lg')}
                    <div class="dc-chip-pos">${POSITION_LABELS[pos]}</div>
                    <div class="dc-chip-name">${escapeHtml(starter.playerName)}${projectionHtml(starter, projectionById)}</div>
                    ${injury}
                </div>
            </div>`;
        }).join('');

        const benchCols = POSITION_ORDER.map((pos) => {
            const rows = (chart.positions[pos] ?? [])
                .slice(1)
                .map((entry) => {
                    const status = entry.injuryStatus ? `<div class="dc-bench-status ${injuryClass(entry)}">${escapeHtml(entry.injuryStatus)}</div>` : '';
                    return `<div class="dc-bench-player player${entry.playerId === subjectId ? ' is-subject' : ''}"${playerAttrs(entry, tricode)}>
                        <div class="dc-bench-avatar-wrap">${avatarHtml(entry, 'sm')}<span class="dc-bench-rank pm-mono">${entry.depthOrder}</span></div>
                        <div class="dc-bench-meta"><div class="dc-bench-name"><span class="dc-bench-name-text">${escapeHtml(entry.playerName)}</span>${projectionHtml(entry, projectionById)}</div>${status}</div>
                    </div>`;
                })
                .join('');
            return `<div class="dc-bench-col"><div class="dc-bench-col-head">${POSITION_LABELS[pos]}</div>${rows || '<div class="dc-bench-empty">&mdash;</div>'}</div>`;
        }).join('');

        // Everyone the projection leaves out: today's injuries (live) or
        // season-ending ones (ros).
        const unavailable = (chart.unavailable ?? [])
            .map((entry) => {
                const detail = [entry.reason, entry.expectedReturn && `back ${entry.expectedReturn}`].filter(Boolean).join(' · ');
                return `<div class="dc-out-player player${entry.playerId === subjectId ? ' is-subject' : ''}"${playerAttrs(entry, tricode)}>
                    ${avatarHtml(entry, 'sm')}
                    <div class="dc-bench-meta"><div class="dc-out-name">${escapeHtml(entry.playerName)}</div><div class="dc-out-detail">${escapeHtml(detail)}</div></div>
                </div>`;
            })
            .join('');

        return `${head}
            <div class="dc-court-wrap">${COURT_SVG}${chips}</div>
            <div class="dc-caption-row">
                <p class="dc-caption">Bench, ranked by depth &middot; (min/FGA) &middot; tap anyone for their card</p>
                <div class="dc-legend"><span><i class="dc-swatch dtd"></i>Day-To-Day</span><span><i class="dc-swatch out"></i>Out</span></div>
            </div>
            <div class="dc-bench-grid">${benchCols}</div>
            ${unavailable ? `<p class="dc-caption dc-out-caption">Unavailable</p><div class="dc-out-list">${unavailable}</div>` : ''}
            <p class="dc-note">${view.label} projection, ${view.caption} &middot; as of ${escapeHtml(chart.asOfDate)}${chart.notes ? ` &middot; ${escapeHtml(chart.notes)}` : ''}</p>`;
    }

    // Based on the extension's fitBenchNames: if any bench name doesn't fit
    // beside its headshot, the whole bench drops headshots and every name may
    // wrap (on a phone's ~65px columns, measuring which names still overflow
    // after the headshots go proved unreliable).
    function fitBenchNames(root) {
        const grid = root.querySelector('.dc-bench-grid');
        if (!grid) return;
        const names = [...grid.querySelectorAll('.dc-bench-name-text')];
        grid.classList.remove('no-avatars');
        if (names.some((name) => name.scrollWidth > name.clientWidth + 1)) grid.classList.add('no-avatars');
    }

    // ---------- styles ----------

    const CSS = `
        .player { color: inherit; font-weight: 700; text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px; cursor: pointer; }
        .pm-sheet .player { text-decoration: none; font-weight: inherit; }
        .pm-backdrop { position: fixed; inset: 0; z-index: 1000; background: rgba(10, 12, 16, 0.5); display: flex; align-items: flex-end; justify-content: center; }
        .pm-sheet {
            --pm-bg: #ffffff; --pm-bg-alt: #f5f7fa; --pm-border: #dde1e8; --pm-border-strong: #c5cbd5;
            --pm-text: #14181f; --pm-text2: #4c5563; --pm-muted: #8890a0; --pm-danger: #c0392b; --pm-success: #006300;
            --pm-accent: #c2410c; --pm-accent-strong: #9a3412; --pm-accent-soft: #fdece1; --pm-accent-soft-strong: #fad9c2;
            --pm-out: #c0392b; --pm-dtd: #b6790a; --pm-court: #fbf4ee; --pm-proj-bg: #fdf3e9; --pm-proj-edge: #e2a468;
            --pm-shadow: 0 1px 2px rgba(20, 24, 31, 0.04), 0 8px 24px -12px rgba(20, 24, 31, 0.12);
            width: 100%; max-width: min(640px, 100vw); min-width: 0; max-height: 90vh; overflow-y: auto; overscroll-behavior: contain; box-sizing: border-box;
            background: var(--pm-bg); color: var(--pm-text); border-radius: 16px 16px 0 0; padding: 16px 16px 32px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.45;
            box-shadow: 0 -8px 30px rgba(0, 0, 0, 0.25);
        }
        @media (prefers-color-scheme: dark) {
            .pm-sheet {
                --pm-bg: #1b1f27; --pm-bg-alt: #232833; --pm-border: #2e3440; --pm-border-strong: #454d5c;
                --pm-text: #eef1f5; --pm-text2: #b8c0cc; --pm-muted: #8a93a3; --pm-danger: #ff6b5e; --pm-success: #5fd068;
                --pm-accent: #f08a4b; --pm-accent-strong: #f7a26c; --pm-accent-soft: #3a2a20; --pm-accent-soft-strong: #5a3a26;
                --pm-out: #ff6b5e; --pm-dtd: #e0a83a; --pm-court: #262019; --pm-proj-bg: #2c241c; --pm-proj-edge: #d9925a;
                --pm-shadow: 0 8px 24px -12px rgba(0, 0, 0, 0.6);
            }
        }
        .pm-mono { font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; }
        .pm-head { display: flex; gap: 12px; align-items: center; }
        .pm-head img { width: 64px; height: 47px; object-fit: cover; border-radius: 8px; background: var(--pm-bg-alt); flex: none; }
        .pm-titles { flex: 1; min-width: 0; }
        .pm-name { font-size: 18px; font-weight: 800; }
        .pm-sub, .pm-meta { font-size: 13px; color: var(--pm-muted); }
        .pm-meta { margin-top: 2px; }
        .pm-sep { margin: 0 6px; }
        .pm-close { flex: none; align-self: flex-start; border: 0; background: transparent; color: var(--pm-muted); font-size: 28px; line-height: 1; padding: 2px 6px; cursor: pointer; }
        .pm-section { margin-top: 20px; }
        .pm-section-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
        .pm-section-row h3 { margin: 0; font-size: 12px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; color: var(--pm-muted); }
        .pm-hint { font-size: 11px; color: var(--pm-muted); }
        .pm-empty { font-style: italic; color: var(--pm-muted); padding: 8px 0; font-size: 14px; }
        .pm-empty.error { color: var(--pm-danger); font-style: normal; }
        body.pm-open { overflow: hidden; }

        .pm-segmented { display: inline-flex; background: var(--pm-bg-alt); border: 1px solid var(--pm-border); border-radius: 8px; padding: 2px; gap: 2px; }
        .pm-segmented button { font: inherit; font-size: 12px; font-weight: 700; color: var(--pm-text2); background: transparent; border: 0; border-radius: 6px; padding: 5px 10px; cursor: pointer; }
        .pm-catvalue[data-mode="game"] button[data-mode="game"], .pm-catvalue[data-mode="min"] button[data-mode="min"] { background: var(--pm-accent); color: #fff; }
        .pm-catvalue[data-mode="game"] [data-pane="min"], .pm-catvalue[data-mode="min"] [data-pane="game"] { display: none; }
        .pm-pane-meta { text-align: right; font-size: 12px; color: var(--pm-muted); margin-bottom: 2px; }
        .pm-chart { display: block; width: 100%; height: auto; }
        .pm-chart .baseline, .pm-chart .divider { stroke: var(--pm-border); stroke-width: 1; }
        .pm-chart .amount { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; font-weight: 600; fill: var(--pm-text); }
        .pm-chart .amount.neg { fill: var(--pm-danger); }
        .pm-chart .label { font-size: 11px; font-weight: 800; letter-spacing: 0.02em; fill: var(--pm-muted); }
        .pm-chart .stat { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; font-weight: 700; fill: var(--pm-text); }
        .pm-chart .att { font-size: 10px; fill: var(--pm-muted); }

        .pm-scroll { overflow-x: auto; border: 1px solid var(--pm-border); border-radius: 10px; -webkit-overflow-scrolling: touch; }
        .pm-table { border-collapse: separate; border-spacing: 0; width: 100%; min-width: 720px; }
        .pm-table th { background: var(--pm-bg-alt); border-bottom: 1px solid var(--pm-border-strong); font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--pm-muted); padding: 7px 6px; text-align: center; white-space: nowrap; }
        .pm-table td { padding: 5px 6px; text-align: center; font-size: 12.5px; border-bottom: 1px solid var(--pm-border); color: var(--pm-text2); white-space: nowrap; background: var(--pm-bg); }
        .pm-table tbody tr:last-child td { border-bottom: 0; }
        /* Split column stays put while the stats scroll sideways. */
        .pm-table .pm-th-window, .pm-table .pm-row-window { position: sticky; left: 0; z-index: 1; text-align: left; padding-left: 12px; box-shadow: 1px 0 0 var(--pm-border); }
        .pm-row-window { font-size: 10.5px !important; font-weight: 700; letter-spacing: 0.04em; color: var(--pm-muted) !important; }
        .pm-row-proj td { background: var(--pm-proj-bg); }
        .pm-row-proj .pm-row-window { color: var(--pm-proj-edge) !important; }
        .pm-row-unq td { color: var(--pm-muted); }
        .pm-proj-tag { display: inline-block; font-size: 8.5px; font-weight: 800; letter-spacing: 0.06em; color: var(--pm-proj-edge); border: 1px solid var(--pm-proj-edge); border-radius: 4px; padding: 1px 4px; margin-left: 5px; vertical-align: 1px; }
        .pm-badges { display: inline-flex; gap: 3px; margin-left: 5px; vertical-align: -1px; }
        .pm-badge { width: 12px; height: 12px; object-fit: contain; }
        .pm-empty-cell { text-align: left !important; font-style: italic; font-size: 11.5px !important; color: var(--pm-muted) !important; padding-left: 14px !important; }
        .pm-pct { display: inline-flex; flex-direction: column; align-items: flex-end; line-height: 1.15; }
        .pm-pct-att { font-size: 9px; font-weight: 600; color: var(--pm-muted); margin-top: 1px; }
        .pm-cell-fpts { font-weight: 700; color: var(--pm-text) !important; }
        .pm-cell-value { font-weight: 700; }

        .pm-news { padding: 10px 0; border-top: 1px solid var(--pm-border); }
        .pm-news:first-child { border-top: 0; padding-top: 2px; }
        .pm-news-meta { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--pm-muted); margin-bottom: 4px; }
        .pm-news-headline { font-weight: 700; margin-bottom: 4px; }
        .pm-news-story { color: var(--pm-text2); font-size: 14px; }

        .dc-legend { display: flex; gap: 12px; font-size: 11px; color: var(--pm-muted); }
        .dc-legend span { display: inline-flex; align-items: center; gap: 5px; }
        .dc-swatch { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
        .dc-swatch.dtd { background: var(--pm-dtd); }
        .dc-swatch.out { background: var(--pm-out); }
        .dc-court-wrap { position: relative; width: 100%; max-width: 400px; margin: 0 auto 18px; aspect-ratio: 480 / 600; }
        .dc-court-svg { width: 100%; height: 100%; display: block; }
        .dc-chip { position: absolute; transform: translate(-50%, -50%); width: 92px; text-align: center; }
        .dc-chip-inner { display: flex; flex-direction: column; align-items: center; }
        .dc-chip.is-subject .dc-avatar-lg { box-shadow: 0 0 0 1.5px var(--pm-border-strong), 0 0 0 4px var(--pm-accent-soft-strong), var(--pm-shadow); }
        .dc-avatar { border-radius: 50%; overflow: hidden; background: var(--pm-bg-alt); display: flex; align-items: center; justify-content: center; font-weight: 800; color: var(--pm-text2); flex: none; }
        .dc-avatar img { width: 100%; height: 100%; object-fit: cover; }
        .dc-avatar-lg { width: 52px; height: 52px; border: 2.5px solid var(--pm-bg); box-shadow: 0 0 0 1.5px var(--pm-border-strong), var(--pm-shadow); font-size: 14px; }
        .dc-avatar-sm { width: 26px; height: 26px; border: 1.5px solid var(--pm-border-strong); font-size: 9px; }
        .dc-chip-pos { font-size: 8.5px; font-weight: 800; letter-spacing: 0.04em; color: var(--pm-accent-strong); background: var(--pm-accent-soft); border: 1px solid var(--pm-accent-soft-strong); border-radius: 4px; padding: 1px 5px; margin-top: 5px; }
        .dc-chip-name { font-size: 11.5px; font-weight: 700; color: var(--pm-text); margin-top: 3px; line-height: 1.2; }
        .dc-chip.is-subject .dc-chip-name { color: var(--pm-accent-strong); }
        .dc-chip-injury { font-size: 9px; font-weight: 800; color: var(--pm-dtd); margin-top: 2px; display: flex; align-items: center; gap: 3px; }
        .dc-chip-injury::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: currentColor; flex: none; }
        .dc-chip-injury.out { color: var(--pm-out); }
        .dc-caption { font-size: 11px; color: var(--pm-muted); margin: 0 0 10px; }
        .dc-bench-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
        .dc-bench-col-head { font-size: 10.5px; font-weight: 800; letter-spacing: 0.04em; color: var(--pm-muted); text-align: center; padding-bottom: 6px; border-bottom: 1px solid var(--pm-border); margin-bottom: 6px; }
        .dc-bench-col { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
        .dc-bench-player { display: flex; align-items: center; gap: 6px; padding: 4px; border-radius: 8px; }
        .dc-bench-player.is-subject { background: var(--pm-accent-soft); box-shadow: inset 0 0 0 1.5px var(--pm-accent-soft-strong); }
        .dc-bench-avatar-wrap { position: relative; flex: none; }
        .dc-bench-rank { position: absolute; bottom: -3px; right: -3px; font-size: 7.5px; font-weight: 700; background: var(--pm-bg); color: var(--pm-muted); border: 1px solid var(--pm-border-strong); border-radius: 50%; width: 13px; height: 13px; display: flex; align-items: center; justify-content: center; line-height: 1; }
        .dc-bench-meta { min-width: 0; }
        .dc-bench-grid.no-avatars .dc-bench-avatar-wrap { display: none; }
        .dc-bench-grid.no-avatars .dc-bench-name { flex-wrap: wrap; white-space: normal; }
        .dc-bench-grid.no-avatars .dc-bench-name-text { overflow: visible; overflow-wrap: anywhere; }
        .dc-bench-name { display: flex; align-items: baseline; gap: 3px; font-size: 10.5px; font-weight: 700; color: var(--pm-text2); white-space: nowrap; line-height: 1.2; }
        .dc-bench-name-text { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
        .dc-chip-name .dc-proj { display: block; }
        .dc-proj { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9.5px; font-weight: 600; color: var(--pm-muted); white-space: nowrap; flex: none; }
        .dc-bench-player.is-subject .dc-bench-name { color: var(--pm-accent-strong); }
        .dc-bench-status { font-size: 8.5px; font-weight: 700; margin-top: 1px; }
        .dc-bench-status.dtd { color: var(--pm-dtd); }
        .dc-bench-status.out { color: var(--pm-out); }
        .dc-bench-empty { font-size: 11px; color: var(--pm-muted); text-align: center; padding-top: 4px; }
        .dc-view-toggle button.on { background: var(--pm-accent); color: #fff; }
        .dc-caption-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
        .dc-caption-row .dc-caption { margin: 0; }
        .dc-out-caption { margin-top: 16px; }
        .dc-out-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; }
        .dc-out-player { display: flex; align-items: center; gap: 6px; padding: 4px; border-radius: 8px; min-width: 0; }
        .dc-out-player.is-subject { background: var(--pm-accent-soft); box-shadow: inset 0 0 0 1.5px var(--pm-accent-soft-strong); }
        .dc-out-name { font-size: 10.5px; font-weight: 700; color: var(--pm-out); line-height: 1.2; }
        .dc-out-detail { font-size: 9.5px; color: var(--pm-muted); line-height: 1.25; margin-top: 1px; }
        .dc-note { font-size: 10.5px; color: var(--pm-muted); line-height: 1.4; margin: 14px 0 0; }
    `;

    // ---------- modal ----------

    let backdrop = null;
    let openToken = 0;
    let resizeObserver = null;

    function close() {
        resizeObserver?.disconnect();
        resizeObserver = null;
        backdrop?.remove();
        backdrop = null;
        document.body.classList.remove('pm-open');
        openToken++;
    }

    const loading = (what) => `<div class="pm-empty">Loading ${what}&hellip;</div>`;
    const failed = (what, error) => `<div class="pm-empty error">Couldn't load ${what}: ${escapeHtml(error.message)}</div>`;

    async function open(el) {
        close();
        const token = ++openToken;
        const isCurrent = () => token === openToken;
        const name = el.dataset.name || el.textContent.trim();
        const team = toTricode(el.dataset.team);

        backdrop = document.createElement('div');
        backdrop.className = 'pm-backdrop';
        backdrop.innerHTML = `<div class="pm-sheet" role="dialog" aria-modal="true" aria-label="${escapeHtml(name)}">
            <div class="pm-head">
                <img alt="" hidden>
                <div class="pm-titles"><div class="pm-name">${escapeHtml(name)}</div><div class="pm-sub">${escapeHtml(team)}</div><div class="pm-meta"></div></div>
                <button class="pm-close" type="button" aria-label="Close">&times;</button>
            </div>
            <section class="pm-section pm-s-value">${loading('projections')}</section>
            <section class="pm-section pm-s-stats"></section>
            <section class="pm-section"><div class="pm-section-row"><h3>Latest news</h3></div><div class="pm-s-news">${loading('news')}</div></section>
            <section class="pm-section pm-s-depth">${loading('depth chart')}</section>
        </div>`;
        backdrop.addEventListener('click', (event) => {
            if (event.target === backdrop || event.target.closest('.pm-close')) close();
        });
        document.body.appendChild(backdrop);
        document.body.classList.add('pm-open');
        const $ = (sel) => backdrop.querySelector(sel);

        let player = null;
        try {
            player = await fetchPlayer(name, team);
        } catch (error) {
            if (!isCurrent()) return;
            $('.pm-s-value').innerHTML = failed('projections', error);
        }
        if (!isCurrent()) return;

        if (player) {
            const ros = player.stats?.[VALUE_WINDOW];
            const total = player.categoryValue?.[VALUE_WINDOW]?.total;
            $('.pm-sub').textContent = [player.team, player.position].filter(Boolean).join(' · ');
            const meta = [];
            if (total != null) meta.push(`<span class="pm-mono" style="color:${valueColor(total)};font-weight:800">${dollar(total)}</span> per game ROS`);
            if (ros) meta.push(`${fmt1(ros.minutesPerGame)} mpg`, `${fmt0(ros.gamesPlayed)} games left`);
            $('.pm-meta').innerHTML = meta.join('<span class="pm-sep">&middot;</span>');
            const img = $('.pm-head img');
            img.src = player.headshotUrl || headshotUrl(player.playerId);
            img.hidden = false;
            $('.pm-s-value').innerHTML = valueSectionHtml(player);
            wireValueToggle($('.pm-s-value'));
            $('.pm-s-stats').innerHTML = statsTableHtml(player);
            wireImageFallbacks($('.pm-s-stats'));
        } else if (!$('.pm-s-value .error')) {
            $('.pm-s-value').innerHTML = '<div class="pm-empty">Player not found in the projection pool.</div>';
        }

        // News needs the ESPN id; the depth chart can fall back to the link's team.
        if (player) {
            fetchNews(player.playerId)
                .then((news) => isCurrent() && ($('.pm-s-news').innerHTML = newsHtml(news)))
                .catch((error) => isCurrent() && ($('.pm-s-news').innerHTML = failed('news', error)));
        } else {
            $('.pm-s-news').innerHTML = '<div class="pm-empty">No player id, so no news.</div>';
        }

        const tricode = player?.team || team;
        if (!tricode) {
            $('.pm-s-depth').innerHTML = '';
            return;
        }
        try {
            const [playingTime, projectionById] = await Promise.all([fetchPlayingTime(tricode), fetchTeamProjections(tricode).catch(() => new Map())]);
            if (!isCurrent()) return;
            const section = $('.pm-s-depth');
            const render = (viewKey) => {
                section.innerHTML = depthChartHtml(playingTime, viewKey, player?.playerId, projectionById);
                wireImageFallbacks(section);
                fitBenchNames(section);
            };
            render('live');
            section.addEventListener('click', (event) => {
                const button = event.target.closest('.dc-view-toggle button');
                if (button && !button.classList.contains('on')) render(button.dataset.view);
            });
            resizeObserver = new ResizeObserver(() => fitBenchNames(section));
            resizeObserver.observe(section);
        } catch (error) {
            if (isCurrent()) $('.pm-s-depth').innerHTML = failed('the depth chart', error);
        }
    }

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    document.addEventListener('click', (event) => {
        const el = event.target.closest?.('.player');
        if (!el) return;
        event.preventDefault();
        open(el);
    });
    document.addEventListener('keydown', (event) => event.key === 'Escape' && close());
})();
