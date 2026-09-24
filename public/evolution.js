// ForgeLoop「模型进化」页：只读展示 + 人工审片 + 待修复队列 + 策略晋级/回滚。
const $ = (sel) => document.querySelector(sel);
const toastEl = $('#toast');

function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { toastEl.hidden = true; }, 2600);
}

async function api(path, options = {}) {
    const res = await fetch(path, {
        headers: { 'Content-Type': 'application/json' },
        ...options
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) throw new Error(json.error || `HTTP ${res.status}`);
    return json.data;
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function boot() {
    const me = await AUTH_API.me();
    if (!me) { location.href = '/login.html'; return; }
    // /me 直接返回 localUserResponse（{id, username, email, isAdmin}），没有 me.user 包裹
    $('#userChip').textContent = me.username || me.email || '';
    await refreshAll();
}

async function refreshAll() {
    await Promise.all([renderOverview(), renderPending(), renderRepairable(), renderChains(), renderPolicies(), renderExperiments()]);
}

async function renderOverview() {
    const d = await api('/api/learning/overview');
    const t = d.totals;
    const cards = [
        ['建模 Attempt', t.attempts], ['失败/打回', t.failed], ['人工通过', t.approved],
        ['人工打回', t.rejected], ['待审片', t.pending], ['有效因果链', t.valid_chains]
    ];
    $('#cards').innerHTML = cards.map(([l, v]) => `<div class="card"><div class="num">${v}</div><div class="lbl">${escapeHtml(l)}</div></div>`).join('');

    const dist = d.failure_distribution || {};
    const entries = Object.entries(dist);
    if (!entries.length) $('#failDist').innerHTML = '<div class="empty">还没有失败 Attempt。</div>';
    else {
        const max = Math.max(...entries.map(([, c]) => c));
        $('#failDist').innerHTML = entries
            .sort((a, b) => b[1] - a[1])
            .map(([cat, c]) => `
                <div class="bar-row">
                    <span class="name">${escapeHtml(d.failure_labels[cat] || cat)}</span>
                    <div class="bar-track"><div class="bar-fill" style="width:${Math.round(c / max * 100)}%"></div></div>
                    <span class="cnt">${c}</span>
                </div>`).join('');
    }

    const trend = d.monthly_trend || {};
    const months = Object.keys(trend).sort();
    if (!months.length) $('#trend').innerHTML = '<div class="empty">还没有按月统计。</div>';
    else {
        $('#trend').innerHTML = '<table><tr><th>月份</th><th>通过</th><th>打回</th><th>待审</th></tr>' +
            months.map(m => `<tr><td>${escapeHtml(m)}</td><td>${trend[m].approved || 0}</td><td>${trend[m].rejected || 0}</td><td>${trend[m].pending || 0}</td></tr>`).join('') +
            '</table>';
    }
    window._failureCategories = d.failure_categories || [];
    window._failureLabels = d.failure_labels || {};
}

async function renderPending() {
    const list = await api('/api/learning/attempts/pending');
    if (!list.length) { $('#pending').innerHTML = '<div class="empty">没有待审片的模型。</div>'; return; }
    const cats = window._failureCategories || [];
    // 空选项只放一次，再展开各失败原因（修复重复空选项 bug）
    const catOptions = ['<option value="">打回原因…</option>', ...cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(window._failureLabels[c] || c)}</option>`)].join('');
    $('#pending').innerHTML = list.map(a => `
        <div class="pending-item" data-id="${a.id}">
            <div class="row">
                <b>${escapeHtml(a.id)}</b><span class="badge">${escapeHtml(a.asset_kind)}</span><span class="badge">${escapeHtml(a.profile)}</span>
                <span class="muted">${escapeHtml(new Date(a.created_at).toLocaleString())}</span>
                <a class="link" href="/modeling.html?job=${encodeURIComponent(a.job_id)}" target="_blank" rel="noopener">在 Three.js 预览 ↗</a>
            </div>
            <div class="muted" style="margin:6px 0">${escapeHtml(a.prompt || '(无提示词)')} · 质量分 ${a.quality_score == null ? '—' : a.quality_score.toFixed(2)}</div>
            <div class="row">
                <label class="muted">验证范围
                    <select class="scope">
                        <option value="">未复测</option>
                        <option value="viewer">Three.js 预览</option>
                        <option value="game">游戏内</option>
                    </select>
                </label>
                <select class="cat">${catOptions}</select>
                <input class="score" type="number" min="1" max="5" placeholder="缺陷评分1~5(打回必填)">
                <input class="notes" placeholder="备注（可选）" style="flex:1;min-width:150px">
                <button class="btn approve" type="button">通过</button>
                <button class="btn reject" type="button">打回</button>
            </div>
        </div>`).join('');

    $('#pending').querySelectorAll('.pending-item').forEach(el => {
        const id = el.dataset.id;
        el.querySelector('.approve').onclick = () => review(id, 'approved', el);
        el.querySelector('.reject').onclick = () => review(id, 'rejected', el);
    });
}

async function review(id, verdict, el) {
    const scope = el.querySelector('.scope').value;
    const category = el.querySelector('.cat').value || null;
    const scoreRaw = el.querySelector('.score').value;
    const score = scoreRaw === '' ? null : Number(scoreRaw);
    const notes = el.querySelector('.notes').value;
    if (verdict === 'rejected' && !category) return toast('打回必须选择失败原因');
    if (verdict === 'rejected' && (score === null || score < 1 || score > 5)) return toast('打回必须给出 1~5 的缺陷评分');
    try {
        await api(`/api/learning/attempts/${id}/review`, {
            method: 'POST',
            body: JSON.stringify({ verdict, category, defect_score: score, notes, validation_scope: scope })
        });
        toast(verdict === 'approved' ? '已通过审片' : '已打回，经验库记录原因与缺陷评分');
        await refreshAll();
    } catch (e) { toast(e.message); }
}

async function renderRepairable() {
    const list = await api('/api/learning/attempts/repairable');
    if (!list.length) { $('#repairable').innerHTML = '<div class="empty">没有需要修复的 Attempt。</div>'; return; }
    // 并行拉取每个可修复项的三档推荐（best-effort，失败不影响展示）
    const recs = await Promise.all(list.map(a => api('/api/learning/recommend', {
        method: 'POST',
        body: JSON.stringify({ asset_kind: a.asset_kind, profile: a.profile, defect_category: a.failure_category })
    }).then(d => d.candidates || []).catch(() => [])));

    $('#repairable').innerHTML = list.map((a, i) => {
        const cands = recs[i] || [];
        const varOptions = ['<option value="">选择要修改的变量…</option>', ...a.variables.map(v => {
            const cur = v.current === undefined || v.current === null ? '' : JSON.stringify(v.current);
            return `<option value="${escapeHtml(v.param)}" data-cur="${escapeHtml(cur)}">${escapeHtml(v.label)}${cur ? `（当前 ${escapeHtml(cur)}）` : ''}</option>`;
        })].join('');
        const recBlock = cands.length ? `<details class="recs"><summary>三档推荐</summary>` + cands.map(c => `
            <div class="rec" data-params="${escapeHtml(JSON.stringify(c.params || {}))}" data-var="${escapeHtml(c.changed_variable?.param || '')}" data-to="${escapeHtml(JSON.stringify(c.changed_variable?.to ?? ''))}">
                <b>[${escapeHtml(c.tier)}] ${escapeHtml(c.name)}</b> · 风险 ${escapeHtml(c.risk || '—')}
                <div class="muted">${escapeHtml(c.rationale || '')}</div>
                <button class="btn compact apply-rec" type="button">套用到修复表单</button>
            </div>`).join('') + '</details>' : '';
        return `
            <div class="pending-item repair-item" data-id="${a.id}">
                <div class="row">
                    <b>${escapeHtml(a.id)}</b><span class="badge">${escapeHtml(a.asset_kind)}</span><span class="badge">${escapeHtml(a.profile)}</span>
                    <span class="badge reject-badge">${escapeHtml(window._failureLabels[a.failure_category] || a.failure_category || '失败')}</span>
                    <span class="muted">剩余修复 ${a.remaining_repairs} 次</span>
                    <a class="link" href="/modeling.html?job=${encodeURIComponent(a.job_id)}" target="_blank" rel="noopener">Three.js 预览 ↗</a>
                </div>
                <div class="muted" style="margin:6px 0">${escapeHtml(a.failure_detail || '(无失败详情)')}${a.defect_score != null ? ` · 缺陷评分 ${a.defect_score}` : ''} · 质量分 ${a.quality_score == null ? '—' : a.quality_score.toFixed(2)}</div>
                ${recBlock}
                <div class="row repair-form">
                    <select class="var">${varOptions}</select>
                    <input class="val" placeholder="目标值" style="width:130px">
                    <input class="reason" placeholder="修复理由（可选）" style="flex:1;min-width:140px">
                    <button class="btn repair" type="button">创建修复任务</button>
                </div>
            </div>`;
    }).join('');

    $('#repairable').querySelectorAll('.repair-item').forEach(el => {
        const id = el.dataset.id;
        const applyRec = (params, vparam, vto) => {
            const sel = el.querySelector('.var');
            if (vparam && [...sel.options].some(o => o.value === vparam)) { sel.value = vparam; }
            el.querySelector('.val').value = vto === '' || vto === undefined ? '' : JSON.parse(vto);
            el.querySelector('.reason').focus();
        };
        el.querySelectorAll('.apply-rec').forEach(btn => btn.onclick = () => {
            try {
                const params = JSON.parse(btn.closest('.rec').dataset.params);
                const vparam = btn.closest('.rec').dataset.var;
                const vto = btn.closest('.rec').dataset.to;
                applyRec(params, vparam, vto);
            } catch (e) { toast('推荐参数解析失败'); }
        });
        el.querySelector('.repair').onclick = async () => {
            const sel = el.querySelector('.var');
            const param = sel.value;
            const cur = sel.selectedOptions[0]?.dataset.cur;
            if (!param) return toast('请选择要修改的变量');
            let to = el.querySelector('.val').value;
            if (param.startsWith('generation.roughness_floor') || param.startsWith('generation.specular_level') || param === 'generation.roughness_floor' || param === 'generation.specular_level') {
                to = Number(to);
            } else if (param === 'seed' || param === 'generation.triangle_budget' || param === 'generation.paint_views') {
                to = Number(to);
            } else if (param === 'generation.texture_size' || param === 'generation.paint_resolution') {
                to = Number(to);
            }
            const reason = el.querySelector('.reason').value;
            try {
                const r = await api(`/api/learning/attempts/${id}/repair`, {
                    method: 'POST',
                    body: JSON.stringify({ variable: { param, from: cur === '' ? undefined : JSON.parse(cur), to, reason } })
                });
                toast(`已创建修复任务 ${r.job.id}（剩余 ${r.remaining_after} 次）`);
                await refreshAll();
            } catch (e) { toast(e.message); }
        };
    });
}

async function renderChains() {
    const list = await api('/api/learning/retrospectives');
    const valid = list.filter(r => r.chain_valid);
    if (!valid.length) { $('#chains').innerHTML = '<div class="empty">还没有闭合的「失败—修复—批准」因果链。</div>'; return; }
    $('#chains').innerHTML = valid.map(r => `
        <div class="chain" data-id="${escapeHtml(r.id)}">
            <div>
                <b>${escapeHtml(r.failed_attempt_id)}</b>（${escapeHtml(window._failureLabels[r.defect_category] || r.defect_category || '')}）
                → 只改 <code>${escapeHtml(r.changed_variable?.param)}</code>：${escapeHtml(JSON.stringify(r.changed_variable?.from ?? ''))} → ${escapeHtml(JSON.stringify(r.changed_variable?.to ?? ''))}
                → <b>${escapeHtml(r.fixed_attempt_id)}</b> ✓
            </div>
            <div class="muted">${escapeHtml(r.defect_detail || '')}${r.evidence?.game_verified ? ' · 已游戏内验证' : ''}</div>
            <button class="btn compact make-policy" type="button">从这条有效复盘创建草稿策略</button>
        </div>`).join('');
    $('#chains').querySelectorAll('.make-policy').forEach(btn => btn.onclick = async () => {
        const chainEl = btn.closest('.chain');
        const retro = valid.find(r => r.id === chainEl.dataset.id);
        const name = window.prompt('策略名称：', `修复${window._failureLabels[retro.defect_category] || retro.defect_category || '缺陷'}策略`);
        if (name === null) return;
        try {
            const p = await api('/api/learning/policies', {
                method: 'POST',
                body: JSON.stringify({
                    asset_kind: retro.asset_kind,
                    scope: { profile: retro.profile },
                    name,
                    description: `源自有效复盘 ${retro.id}：${retro.changed_variable?.param} ${JSON.stringify(retro.changed_variable?.from)}→${JSON.stringify(retro.changed_variable?.to)}`,
                    basis_retro_ids: [retro.id]
                })
            });
            toast(`已创建草稿策略 ${p.id}`);
            await renderPolicies();
        } catch (e) { toast(e.message); }
    });
}

async function renderPolicies() {
    const list = await api('/api/learning/policies?include_rolled_back=1');
    if (!list.length) { $('#policies').innerHTML = '<div class="empty">还没有策略。可从一条有效因果链人工提炼为草稿策略。</div>'; return; }
    const nextMap = { draft: 'shadow', shadow: 'small_scale', small_scale: 'default' };
    $('#policies').innerHTML = '<table><tr><th>名称</th><th>类型</th><th>阶段</th><th>证据数</th><th>操作</th></tr>' +
        list.map(p => `
            <tr data-id="${p.id}">
                <td>${escapeHtml(p.name)}<div class="muted">${escapeHtml(p.description || '')}</div></td>
                <td>${escapeHtml(p.asset_kind)}</td>
                <td><span class="badge ${escapeHtml(p.lifecycle)}">${escapeHtml(p.lifecycle_label)}</span></td>
                <td>${p.evidence_case_count}${p.game_verified_count ? `（游戏验证 ${p.game_verified_count}）` : ''}</td>
                <td>
                    ${p.lifecycle !== 'rolled_back' && nextMap[p.lifecycle] ? `<button class="btn advance" data-next="${nextMap[p.lifecycle]}" type="button">晋级→${nextMap[p.lifecycle]}</button>` : ''}
                    ${p.lifecycle !== 'rolled_back' ? `<button class="btn rollback" type="button">回滚</button>` : `<span class="muted">${escapeHtml(p.rollback_reason || '')}</span>`}
                </td>
            </tr>`).join('') + '</table>';

    $('#policies').querySelectorAll('tr[data-id]').forEach(tr => {
        const id = tr.dataset.id;
        const adv = tr.querySelector('.advance');
        if (adv) adv.onclick = async () => {
            try {
                const d = await api(`/api/learning/policies/${id}/advance`, { method: 'POST', body: JSON.stringify({ lifecycle: adv.dataset.next }) });
                toast(`策略已晋级为 ${d.lifecycle_label}（服务端证据：有效链 ${d.evidence.valid}，游戏验证 ${d.evidence.game_verified}）`);
                await refreshAll();
            } catch (e) {
                toast(`${e.message}`); // 服务端返回的阻断原因与证据数直接展示
            }
        };
        const rb = tr.querySelector('.rollback');
        if (rb) rb.onclick = async () => {
            const reason = prompt('回滚原因：', '回滚');
            if (reason === null) return;
            try { await api(`/api/learning/policies/${id}/advance`, { method: 'POST', body: JSON.stringify({ lifecycle: 'rolled_back', reason }) }); toast('已回滚'); await refreshAll(); }
            catch (e) { toast(e.message); }
        };
    });
}

async function renderExperiments() {
    const list = await api('/api/learning/experiments');
    if (!list.length) { $('#experiments').innerHTML = '<div class="empty">还没有受控实验。</div>'; return; }
    $('#experiments').innerHTML = '<table><tr><th>假设</th><th>变量</th><th>基线→候选</th><th>结果</th></tr>' +
        list.map(e => `<tr>
            <td>${escapeHtml(e.hypothesis || '')}</td>
            <td><code>${escapeHtml(e.variable?.param || '—')}</code></td>
            <td>${escapeHtml(e.baseline_attempt_id || '—')} → ${escapeHtml(e.candidate_attempt_id || '—')}</td>
            <td><span class="badge">${escapeHtml(e.result)}</span></td>
        </tr>`).join('') + '</table>';
}

$('#refreshBtn').onclick = refreshAll;
$('#logoutBtn').onclick = async () => { await AUTH_API.logout(); location.href = '/login.html'; };
boot().catch(e => toast(e.message));