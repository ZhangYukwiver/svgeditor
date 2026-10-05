/* VectorLite: a dependency-free SVG editor prototype. */
(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DEFAULT_DOC = { width: 1200, height: 800, background: '#ffffff', name: '未命名.svg', groups: [], elements: [] };
  const svg = document.getElementById('editor-canvas');
  const viewport = document.getElementById('canvas-viewport');
  const stage = document.getElementById('canvas-stage');
  const elementsLayer = document.getElementById('artboard-elements');
  const selectionLayer = document.getElementById('selection-layer');
  const draftLayer = document.getElementById('draft-layer');
  const fileInput = document.getElementById('file-input');
  const toastEl = document.getElementById('toast');
  const textEditor = document.getElementById('text-editor');
  const textEditorInput = textEditor.querySelector('textarea');

  const state = {
    doc: structuredClone(DEFAULT_DOC),
    tool: 'select',
    selectedIds: [],
    zoom: 1,
    history: [],
    historyIndex: -1,
    isDirty: false,
    interaction: null,
    penPoints: [],
    textEditingId: null,
    spacePanning: false,
    panStart: null,
    toastTimer: null
  };

  const uid = (prefix = 'obj') => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
  const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const isMac = navigator.platform.toLowerCase().includes('mac');
  const modKey = (event) => isMac ? event.metaKey : event.ctrlKey;

  function defaultStyle() {
    return { fill: '#8b5cf6', stroke: '#5b21b6', strokeWidth: 2, opacity: 1 };
  }

  function makeElement(type, point, end = point) {
    const style = defaultStyle();
    const x = point.x;
    const y = point.y;
    if (type === 'rect') return { id: uid('rect'), type, name: '矩形', x, y, width: 1, height: 1, rotation: 0, ...style, visible: true, locked: false };
    if (type === 'ellipse') return { id: uid('ellipse'), type, cx: x, cy: y, rx: 1, ry: 1, rotation: 0, ...style, visible: true, locked: false };
    if (type === 'line') return { id: uid('line'), type, x1: x, y1: y, x2: end.x, y2: end.y, fill: 'none', stroke: '#8b5cf6', strokeWidth: 3, opacity: 1, visible: true, locked: false, name: '直线' };
    if (type === 'text') return { id: uid('text'), type, x, y, text: '双击编辑文字', fontSize: 42, fontFamily: 'Inter, Segoe UI, sans-serif', fontWeight: 600, rotation: 0, fill: '#172033', stroke: 'none', strokeWidth: 0, opacity: 1, visible: true, locked: false, name: '文字' };
    return { id: uid('path'), type: 'path', points: [{ x, y }, { x: end.x, y: end.y }], closed: false, rotation: 0, ...style, visible: true, locked: false, name: '路径' };
  }

  function snapshot() {
    return JSON.stringify(state.doc);
  }

  function restoreSnapshot(raw) {
    state.doc = JSON.parse(raw);
    state.selectedIds = [];
    state.isDirty = true;
    render();
  }

  function pushHistory() {
    const current = snapshot();
    if (state.history[state.historyIndex] === current) return;
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(current);
    state.historyIndex = state.history.length - 1;
    if (state.history.length > 50) {
      state.history.shift();
      state.historyIndex -= 1;
    }
    state.isDirty = true;
    updateDocumentState();
  }

  function undo() {
    if (state.historyIndex <= 0) return showToast('没有可撤销的操作');
    state.historyIndex -= 1;
    restoreSnapshot(state.history[state.historyIndex]);
    showToast('已撤销');
  }

  function redo() {
    if (state.historyIndex >= state.history.length - 1) return showToast('没有可重做的操作');
    state.historyIndex += 1;
    restoreSnapshot(state.history[state.historyIndex]);
    showToast('已重做');
  }

  function setTool(tool) {
    state.tool = tool;
    state.penPoints = [];
    state.interaction = null;
    document.querySelectorAll('[data-tool]').forEach((button) => button.classList.toggle('is-active', button.dataset.tool === tool));
    svg.style.cursor = tool === 'select' ? 'default' : tool === 'text' ? 'text' : 'crosshair';
    renderDraft();
  }

  function clientToSvg(event) {
    const rect = svg.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) * state.doc.width / rect.width, 0, state.doc.width),
      y: clamp((event.clientY - rect.top) * state.doc.height / rect.height, 0, state.doc.height)
    };
  }

  function snapPoint(point, event) {
    if (!event.shiftKey) return point;
    const grid = 12;
    return { x: Math.round(point.x / grid) * grid, y: Math.round(point.y / grid) * grid };
  }

  function elementById(id) { return state.doc.elements.find((item) => item.id === id); }
  function selectedElements() { return state.selectedIds.map(elementById).filter(Boolean); }
  function groupById(id) { return (state.doc.groups || []).find((group) => group.id === id); }
  function isElementVisible(element) { let group = groupById(element.groupId); while (group) { if (!group.visible) return false; group = groupById(group.parentId); } return element.visible !== false; }
  function isElementLocked(element) { let group = groupById(element.groupId); while (group) { if (group.locked) return true; group = groupById(group.parentId); } return element.locked === true; }
  function canEditElement(element) { return Boolean(element) && isElementVisible(element) && !isElementLocked(element); }

  function transformFor(element) {
    let local = '';
    if (element.type === 'rect' || element.type === 'image') local = `rotate(${num(element.rotation)} ${num(element.x) + num(element.width) / 2} ${num(element.y) + num(element.height) / 2})`;
    else if (element.type === 'ellipse') local = `rotate(${num(element.rotation)} ${num(element.cx)} ${num(element.cy)})`;
    else if (element.type === 'text') local = `rotate(${num(element.rotation)} ${num(element.x)} ${num(element.y)})`;
    else if (element.type === 'path') {
      const box = bbox(element);
      local = `rotate(${num(element.rotation)} ${box.x + box.width / 2} ${box.y + box.height / 2})`;
    }
    return [element.transform, local].filter((value) => value && value !== 'rotate(0 0 0)').join(' ');
  }

  function pointsToD(points, closed = false) {
    if (!points.length) return '';
    return `${points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ')}${closed ? ' Z' : ''}`;
  }

  function renderElement(element) {
    if (!isElementVisible(element)) return null;
    const group = document.createElementNS(SVG_NS, 'g');
    group.dataset.elementId = element.id;
    group.setAttribute('transform', transformFor(element));
    group.style.cursor = state.tool === 'select' && !isElementLocked(element) ? 'move' : 'default';
    const common = { fill: element.fill, stroke: element.stroke, 'stroke-width': element.strokeWidth, opacity: element.opacity, 'vector-effect': 'non-scaling-stroke' };
    let shape;
    if (element.type === 'rect') {
      shape = document.createElementNS(SVG_NS, 'rect');
      shape.setAttribute('x', element.x); shape.setAttribute('y', element.y); shape.setAttribute('width', Math.max(0.01, element.width)); shape.setAttribute('height', Math.max(0.01, element.height));
      Object.entries(common).forEach(([key, value]) => shape.setAttribute(key, value));
    } else if (element.type === 'ellipse') {
      shape = document.createElementNS(SVG_NS, 'ellipse');
      shape.setAttribute('cx', element.cx); shape.setAttribute('cy', element.cy); shape.setAttribute('rx', Math.max(0.01, element.rx)); shape.setAttribute('ry', Math.max(0.01, element.ry));
      Object.entries(common).forEach(([key, value]) => shape.setAttribute(key, value));
    } else if (element.type === 'line') {
      shape = document.createElementNS(SVG_NS, 'line');
      shape.setAttribute('x1', element.x1); shape.setAttribute('y1', element.y1); shape.setAttribute('x2', element.x2); shape.setAttribute('y2', element.y2);
      Object.entries(common).forEach(([key, value]) => shape.setAttribute(key, value));
    } else if (element.type === 'image') {
      shape = document.createElementNS(SVG_NS, 'image');
      shape.setAttribute('x', element.x); shape.setAttribute('y', element.y); shape.setAttribute('width', Math.max(0.01, element.width)); shape.setAttribute('height', Math.max(0.01, element.height));
      shape.setAttribute('preserveAspectRatio', element.preserveAspectRatio || 'none'); shape.setAttribute('opacity', element.opacity ?? 1);
      shape.setAttribute('href', element.href); shape.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', element.href);
    } else if (element.type === 'text') {
      shape = document.createElementNS(SVG_NS, 'text');
      shape.setAttribute('x', element.x); shape.setAttribute('y', element.y); shape.setAttribute('fill', element.fill); shape.setAttribute('stroke', element.stroke); shape.setAttribute('stroke-width', element.strokeWidth); shape.setAttribute('opacity', element.opacity); shape.setAttribute('font-size', element.fontSize); shape.setAttribute('font-family', element.fontFamily); shape.setAttribute('font-weight', element.fontWeight); shape.setAttribute('dominant-baseline', 'alphabetic');
      if (element.textAnchor) shape.setAttribute('text-anchor', element.textAnchor);
      shape.textContent = element.text;
    } else {
      shape = document.createElementNS(SVG_NS, 'path');
      shape.setAttribute('d', pointsToD(element.points, element.closed));
      Object.entries(common).forEach(([key, value]) => shape.setAttribute(key, value));
      shape.setAttribute('fill', element.closed ? element.fill : 'none');
    }
    shape.dataset.elementId = element.id;
    if (isElementLocked(element)) shape.style.pointerEvents = 'none';
    group.appendChild(shape);
    return group;
  }

  function bbox(element) {
    if (element.type === 'rect') return { x: element.x, y: element.y, width: element.width, height: element.height };
    if (element.type === 'image') return { x: element.x, y: element.y, width: element.width, height: element.height };
    if (element.type === 'ellipse') return { x: element.cx - element.rx, y: element.cy - element.ry, width: element.rx * 2, height: element.ry * 2 };
    if (element.type === 'line') return { x: Math.min(element.x1, element.x2), y: Math.min(element.y1, element.y2), width: Math.abs(element.x2 - element.x1) || 1, height: Math.abs(element.y2 - element.y1) || 1 };
    if (element.type === 'text') return { x: element.x, y: element.y - element.fontSize, width: Math.max(12, String(element.text).length * element.fontSize * .58), height: element.fontSize * 1.25 };
    const xs = element.points.map((point) => point.x); const ys = element.points.map((point) => point.y);
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(1, Math.max(...xs) - Math.min(...xs)), height: Math.max(1, Math.max(...ys) - Math.min(...ys)) };
  }

  function unionBbox(elements) {
    if (!elements.length) return null;
    const boxes = elements.map(bbox);
    const x = Math.min(...boxes.map((box) => box.x)); const y = Math.min(...boxes.map((box) => box.y));
    const right = Math.max(...boxes.map((box) => box.x + box.width)); const bottom = Math.max(...boxes.map((box) => box.y + box.height));
    return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
  }

  function renderSelection() {
    selectionLayer.replaceChildren();
    const selected = selectedElements();
    const box = unionBbox(selected);
    if (!box) return;
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', box.x - 4); rect.setAttribute('y', box.y - 4); rect.setAttribute('width', box.width + 8); rect.setAttribute('height', box.height + 8); rect.setAttribute('class', 'selection-box');
    selectionLayer.appendChild(rect);
    const handles = [
      ['nw', box.x - 4, box.y - 4], ['n', box.x + box.width / 2, box.y - 4], ['ne', box.x + box.width + 4, box.y - 4],
      ['e', box.x + box.width + 4, box.y + box.height / 2], ['se', box.x + box.width + 4, box.y + box.height + 4], ['s', box.x + box.width / 2, box.y + box.height + 4],
      ['sw', box.x - 4, box.y + box.height + 4], ['w', box.x - 4, box.y + box.height / 2]
    ];
    handles.forEach(([name, x, y]) => { const handle = document.createElementNS(SVG_NS, 'rect'); handle.setAttribute('x', x - 4); handle.setAttribute('y', y - 4); handle.setAttribute('width', 8); handle.setAttribute('height', 8); handle.dataset.handle = name; handle.classList.add('selection-handle', `handle-${name}`); selectionLayer.appendChild(handle); });
    const rotateLine = document.createElementNS(SVG_NS, 'line'); rotateLine.setAttribute('x1', box.x + box.width / 2); rotateLine.setAttribute('y1', box.y - 4); rotateLine.setAttribute('x2', box.x + box.width / 2); rotateLine.setAttribute('y2', box.y - 29); rotateLine.classList.add('selection-rotate-line'); selectionLayer.appendChild(rotateLine);
    const rotate = document.createElementNS(SVG_NS, 'circle'); rotate.setAttribute('cx', box.x + box.width / 2); rotate.setAttribute('cy', box.y - 35); rotate.setAttribute('r', 5); rotate.dataset.handle = 'rotate'; rotate.classList.add('selection-rotate'); selectionLayer.appendChild(rotate);
  }

  function renderDraft() {
    draftLayer.replaceChildren();
    if (state.interaction?.draft) {
      const draft = state.interaction.draft;
      const shape = renderElement(draft);
      if (shape) { shape.classList.add('draft-shape'); draftLayer.appendChild(shape); }
    }
    if (state.tool === 'pen' && state.penPoints.length) {
      const path = document.createElementNS(SVG_NS, 'path'); path.setAttribute('d', pointsToD(state.penPoints)); path.classList.add('pen-preview'); draftLayer.appendChild(path);
      state.penPoints.forEach((point) => { const circle = document.createElementNS(SVG_NS, 'circle'); circle.setAttribute('cx', point.x); circle.setAttribute('cy', point.y); circle.setAttribute('r', 4); circle.classList.add('selection-rotate'); draftLayer.appendChild(circle); });
    }
  }

  function renderLayers() {
    const list = document.getElementById('layers-list');
    list.replaceChildren();
    const groups = state.doc.groups || [];
    const childNodes = (parentId) => [...groups.filter((group) => (group.parentId || null) === (parentId || null)).map((item) => ({ kind: 'group', item })), ...state.doc.elements.filter((element) => (element.groupId || null) === (parentId || null)).map((item) => ({ kind: 'element', item }))].sort((a, b) => {
      const orderA = Number.isFinite(a.item.order) ? a.item.order : Number.MAX_SAFE_INTEGER;
      const orderB = Number.isFinite(b.item.order) ? b.item.order : Number.MAX_SAFE_INTEGER;
      return orderA - orderB;
    });

    const addElementRow = (element, parent) => {
      const row = document.createElement('div'); row.className = `layer-row layer-leaf${state.selectedIds.includes(element.id) ? ' is-selected' : ''}${isElementLocked(element) ? ' is-locked' : ''}`; row.dataset.layerId = element.id; row.style.paddingLeft = '6px';
      const icon = document.createElement('span'); icon.className = 'layer-icon'; icon.innerHTML = iconFor(element.type); row.appendChild(icon);
      const name = document.createElement('span'); name.className = 'layer-name'; name.textContent = element.name || typeLabel(element.type); row.appendChild(name);
      const visibility = document.createElement('button'); visibility.className = 'layer-toggle'; visibility.dataset.toggleVisibility = element.id; visibility.title = element.visible !== false ? '隐藏' : '显示'; visibility.setAttribute('aria-label', visibility.title); visibility.innerHTML = element.visible !== false ? eyeIcon() : eyeOffIcon(); row.appendChild(visibility);
      const lock = document.createElement('button'); lock.className = 'layer-toggle'; lock.dataset.toggleLock = element.id; lock.title = element.locked ? '解锁' : '锁定'; lock.setAttribute('aria-label', lock.title); lock.innerHTML = element.locked ? lockIcon() : unlockIcon(); row.appendChild(lock); parent.appendChild(row);
    };

    const addGroupNode = (group, parent) => {
      const node = document.createElement('div'); node.className = 'layer-tree-node';
      const row = document.createElement('div'); row.className = `layer-row layer-group-row${group.locked ? ' is-locked' : ''}`; row.dataset.groupId = group.id;
      const expander = document.createElement('button'); expander.className = 'layer-expander'; expander.dataset.toggleGroup = group.id; expander.title = group.expanded === false ? '展开分组' : '折叠分组'; expander.setAttribute('aria-label', expander.title); expander.innerHTML = group.expanded === false ? chevronRightIcon() : chevronDownIcon(); row.appendChild(expander);
      const icon = document.createElement('span'); icon.className = 'layer-icon layer-group-icon'; icon.innerHTML = groupIcon(); row.appendChild(icon);
      const name = document.createElement('span'); name.className = 'layer-name'; name.textContent = group.name || '分组'; row.appendChild(name);
      const visibility = document.createElement('button'); visibility.className = 'layer-toggle'; visibility.dataset.toggleGroupVisibility = group.id; visibility.title = group.visible === false ? '显示分组' : '隐藏分组'; visibility.setAttribute('aria-label', visibility.title); visibility.innerHTML = group.visible === false ? eyeOffIcon() : eyeIcon(); row.appendChild(visibility);
      const lock = document.createElement('button'); lock.className = 'layer-toggle'; lock.dataset.toggleGroupLock = group.id; lock.title = group.locked ? '解锁分组' : '锁定分组'; lock.setAttribute('aria-label', lock.title); lock.innerHTML = group.locked ? lockIcon() : unlockIcon(); row.appendChild(lock); node.appendChild(row);
      if (group.expanded !== false) {
        const children = document.createElement('div'); children.className = 'layer-children';
        childNodes(group.id).slice().reverse().forEach((child) => child.kind === 'group' ? addGroupNode(child.item, children) : addElementRow(child.item, children));
        node.appendChild(children);
      }
      parent.appendChild(node);
    };

    childNodes(null).slice().reverse().forEach((child) => child.kind === 'group' ? addGroupNode(child.item, list) : addElementRow(child.item, list));
    document.getElementById('layer-count').textContent = groups.length ? `${state.doc.elements.length} 个对象 · ${groups.length} 个分组` : `${state.doc.elements.length} 个对象`;
  }

  function iconFor(type) { const d = { rect: '<rect x="3" y="4" width="14" height="13" rx="1"/>', ellipse: '<ellipse cx="10" cy="10.5" rx="7" ry="5.5"/>', line: '<path d="m3 17 14-14"/>', path: '<path d="m3 16 5-9 4 6 5-5"/>', text: '<path d="M3 4h14M10 4v13M7 17h6"/>', image: '<rect x="3" y="4" width="14" height="13" rx="1"/><circle cx="8" cy="8" r="1.5"/><path d="m4 16 4-4 3 3 2-2 3 3"/>' }; return `<svg viewBox="0 0 20 20">${d[type] || d.path}</svg>`; }
  function eyeIcon() { return '<svg viewBox="0 0 24 24"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z"/><circle cx="12" cy="12" r="2"/></svg>'; }
  function eyeOffIcon() { return '<svg viewBox="0 0 24 24"><path d="m4 4 16 16M10.5 6.3A9.7 9.7 0 0 1 12 6c5.5 0 9 6 9 6a16 16 0 0 1-3.2 3.7M6.3 6.8C4.2 8.3 3 12 3 12s3.5 6 9 6c1 0 1.9-.2 2.7-.5"/></svg>'; }
  function lockIcon() { return '<svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>'; }
  function unlockIcon() { return '<svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 6.8-2.8"/></svg>'; }
  function groupIcon() { return '<svg viewBox="0 0 24 24"><path d="M3 6.5h7l2 2h9v10H3z"/><path d="M3 6.5V5h6l2 2"/></svg>'; }
  function chevronDownIcon() { return '<svg viewBox="0 0 24 24"><path d="m7 9 5 5 5-5"/></svg>'; }
  function chevronRightIcon() { return '<svg viewBox="0 0 24 24"><path d="m9 7 5 5-5 5"/></svg>'; }
  function typeLabel(type) { return ({ rect: '矩形', ellipse: '椭圆', line: '直线', path: '路径', text: '文字', image: '图片' })[type] || '对象'; }

  function renderProperties() {
    const selected = selectedElements();
    const empty = document.getElementById('empty-properties');
    const form = document.getElementById('property-form');
    const typeLabelEl = document.getElementById('property-type');
    if (!selected.length) { empty.hidden = false; form.hidden = true; typeLabelEl.textContent = '未选择'; return; }
    empty.hidden = true; form.hidden = false; typeLabelEl.textContent = selected.length > 1 ? `${selected.length} 个对象` : typeLabel(selected[0].type);
    const element = selected[0];
    document.getElementById('prop-name').value = element.name || typeLabel(element.type);
    document.getElementById('prop-fill').value = colorValue(element.fill, '#000000'); document.getElementById('prop-fill-text').value = element.fill || 'none';
    document.getElementById('prop-stroke').value = colorValue(element.stroke, '#000000'); document.getElementById('prop-stroke-text').value = element.stroke || 'none';
    document.getElementById('prop-stroke-width').value = element.strokeWidth ?? 0;
    document.getElementById('prop-opacity').value = element.opacity ?? 1; document.getElementById('prop-opacity-value').textContent = `${Math.round((element.opacity ?? 1) * 100)}%`;
    const textFields = document.getElementById('text-fields'); textFields.hidden = element.type !== 'text' || selected.length !== 1;
    if (element.type === 'text' && selected.length === 1) { document.getElementById('prop-text').value = element.text; document.getElementById('prop-font-size').value = element.fontSize; document.getElementById('prop-font-weight').value = element.fontWeight; }
  }

  function colorValue(value, fallback) { return /^#[0-9a-f]{6}$/i.test(value || '') ? value : fallback; }

  function render() {
    svg.setAttribute('viewBox', `0 0 ${state.doc.width} ${state.doc.height}`);
    svg.style.width = `${state.doc.width * state.zoom}px`; svg.style.height = `${state.doc.height * state.zoom}px`;
    document.querySelector('.canvas-grid').setAttribute('width', state.doc.width); document.querySelector('.canvas-grid').setAttribute('height', state.doc.height);
    const bg = document.getElementById('artboard-background'); bg.setAttribute('width', state.doc.width); bg.setAttribute('height', state.doc.height); bg.setAttribute('fill', state.doc.background);
    elementsLayer.replaceChildren(...state.doc.elements.map(renderElement).filter(Boolean));
    const sizeLabel = document.querySelectorAll('.canvas-statusbar span')[1]; if (sizeLabel) sizeLabel.textContent = `SVG 文档 · ${state.doc.width} × ${state.doc.height}`;
    renderSelection(); renderDraft(); renderLayers(); renderProperties(); updateDocumentState(); updateSelectionSummary();
  }

  function updateDocumentState() {
    document.getElementById('document-name').textContent = state.doc.name;
    document.getElementById('document-status').textContent = state.isDirty ? '未保存' : '已保存';
    document.getElementById('dirty-dot').classList.toggle('is-dirty', state.isDirty);
    document.getElementById('dirty-dot').setAttribute('aria-label', state.isDirty ? '未保存' : '已保存');
  }

  function updateSelectionSummary() { document.getElementById('selection-summary').textContent = state.selectedIds.length ? `已选择 ${state.selectedIds.length} 个对象` : '未选择对象'; }

  function select(id, append = false) {
    if (!id) { state.selectedIds = []; }
    else if (!canEditElement(elementById(id))) return;
    else if (append) state.selectedIds = state.selectedIds.includes(id) ? state.selectedIds.filter((item) => item !== id) : [...state.selectedIds, id];
    else state.selectedIds = [id];
    renderSelection(); renderLayers(); renderProperties(); updateSelectionSummary();
  }

  function groupElementIds(groupId) {
    const ids = [];
    const collect = (id) => {
      state.doc.elements.filter((element) => element.groupId === id && canEditElement(element)).forEach((element) => ids.push(element.id));
      (state.doc.groups || []).filter((group) => group.parentId === id).forEach((group) => collect(group.id));
    };
    collect(groupId); return ids;
  }

  function selectGroup(groupId, append = false) {
    const ids = groupElementIds(groupId);
    state.selectedIds = append ? [...new Set([...state.selectedIds, ...ids])] : ids;
    renderSelection(); renderLayers(); renderProperties(); updateSelectionSummary();
  }

  function beginShape(point, event) {
    const snapped = snapPoint(point, event);
    const draft = makeElement(state.tool, snapped, snapped);
    state.interaction = { kind: 'draw', start: snapped, draft, moved: false };
    renderDraft();
  }

  function updateShape(point, event) {
    const interaction = state.interaction; if (!interaction || interaction.kind !== 'draw') return;
    const end = snapPoint(point, event); const start = interaction.start; interaction.moved = true;
    if (state.tool === 'rect') { interaction.draft.x = Math.min(start.x, end.x); interaction.draft.y = Math.min(start.y, end.y); interaction.draft.width = Math.abs(end.x - start.x); interaction.draft.height = Math.abs(end.y - start.y); }
    else if (state.tool === 'ellipse') { interaction.draft.cx = (start.x + end.x) / 2; interaction.draft.cy = (start.y + end.y) / 2; interaction.draft.rx = Math.abs(end.x - start.x) / 2; interaction.draft.ry = Math.abs(end.y - start.y) / 2; }
    else if (state.tool === 'line') { interaction.draft.x2 = end.x; interaction.draft.y2 = end.y; }
    renderDraft();
  }

  function finishShape() {
    const interaction = state.interaction; if (!interaction || interaction.kind !== 'draw') return;
    const element = interaction.draft;
    if ((element.type === 'rect' && (element.width < 3 || element.height < 3)) || (element.type === 'ellipse' && (element.rx < 2 || element.ry < 2)) || (element.type === 'line' && bbox(element).width < 2 && bbox(element).height < 2)) { state.interaction = null; return renderDraft(); }
    state.doc.elements.push(element); state.selectedIds = [element.id]; state.interaction = null; pushHistory(); render();
  }

  function beginMove(point) {
    const selected = selectedElements(); if (!selected.length || selected.some((element) => !canEditElement(element))) return;
    state.interaction = { kind: 'move', start: point, originals: clone(selected), moved: false };
  }

  function updateMove(point, event) {
    const interaction = state.interaction; if (!interaction || interaction.kind !== 'move') return;
    const dx = point.x - interaction.start.x; const dy = point.y - interaction.start.y;
    selectedElements().forEach((element, index) => { const original = interaction.originals[index]; if (!original) return; applyDelta(element, original, dx, dy); });
    interaction.moved = Math.abs(dx) > .2 || Math.abs(dy) > .2; render();
  }

  function applyDelta(target, original, dx, dy) {
    if (target.type === 'rect') { target.x = original.x + dx; target.y = original.y + dy; }
    else if (target.type === 'image') { target.x = original.x + dx; target.y = original.y + dy; }
    else if (target.type === 'ellipse') { target.cx = original.cx + dx; target.cy = original.cy + dy; }
    else if (target.type === 'line') { target.x1 = original.x1 + dx; target.x2 = original.x2 + dx; target.y1 = original.y1 + dy; target.y2 = original.y2 + dy; }
    else if (target.type === 'text') { target.x = original.x + dx; target.y = original.y + dy; }
    else if (target.type === 'path') target.points = original.points.map((point) => ({ x: point.x + dx, y: point.y + dy }));
  }

  function beginResize(point, handle) {
    const selected = selectedElements(); if (selected.length !== 1 || !canEditElement(selected[0]) || handle === 'rotate') return;
    state.interaction = { kind: 'resize', start: point, handle, original: clone(selected[0]), box: bbox(selected[0]) };
  }

  function updateResize(point, event) {
    const interaction = state.interaction; if (!interaction || interaction.kind !== 'resize') return;
    const { box, handle, original } = interaction; let left = box.x; let right = box.x + box.width; let top = box.y; let bottom = box.y + box.height;
    const p = snapPoint(point, event);
    if (handle.includes('w')) left = Math.min(p.x, right - 4); if (handle.includes('e')) right = Math.max(p.x, left + 4); if (handle.includes('n')) top = Math.min(p.y, bottom - 4); if (handle.includes('s')) bottom = Math.max(p.y, top + 4);
    const element = elementById(state.selectedIds[0]); if (!element) return;
    const sx = (right - left) / Math.max(1, box.width); const sy = (bottom - top) / Math.max(1, box.height);
    if (event.shiftKey) { const scale = Math.max(sx, sy); if (handle.includes('w')) left = right - box.width * scale; else right = left + box.width * scale; if (handle.includes('n')) top = bottom - box.height * scale; else bottom = top + box.height * scale; }
    scaleElement(element, original, box, { left, right, top, bottom }); render();
  }

  function scaleElement(target, original, box, bounds) {
    const sx = (bounds.right - bounds.left) / Math.max(1, box.width); const sy = (bounds.bottom - bounds.top) / Math.max(1, box.height);
    if (target.type === 'rect') { target.x = bounds.left; target.y = bounds.top; target.width = bounds.right - bounds.left; target.height = bounds.bottom - bounds.top; }
    else if (target.type === 'image') { target.x = bounds.left; target.y = bounds.top; target.width = bounds.right - bounds.left; target.height = bounds.bottom - bounds.top; }
    else if (target.type === 'ellipse') { target.cx = bounds.left + (bounds.right - bounds.left) / 2; target.cy = bounds.top + (bounds.bottom - bounds.top) / 2; target.rx = original.rx * sx; target.ry = original.ry * sy; }
    else if (target.type === 'line') { target.x1 = bounds.left; target.y1 = bounds.top; target.x2 = bounds.right; target.y2 = bounds.bottom; }
    else if (target.type === 'text') { target.x = bounds.left; target.y = bounds.bottom; target.fontSize = Math.max(6, original.fontSize * sy); }
    else if (target.type === 'path') target.points = original.points.map((point) => ({ x: bounds.left + (point.x - box.x) * sx, y: bounds.top + (point.y - box.y) * sy }));
  }

  function beginRotate(point) {
    const selected = selectedElements(); if (selected.length !== 1 || !canEditElement(selected[0])) return;
    const box = bbox(selected[0]); state.interaction = { kind: 'rotate', center: { x: box.x + box.width / 2, y: box.y + box.height / 2 }, startAngle: Math.atan2(point.y - (box.y + box.height / 2), point.x - (box.x + box.width / 2)), original: clone(selected[0]) };
  }

  function updateRotate(point, event) {
    const interaction = state.interaction; if (!interaction || interaction.kind !== 'rotate') return;
    let angle = (Math.atan2(point.y - interaction.center.y, point.x - interaction.center.x) - interaction.startAngle) * 180 / Math.PI;
    if (event.shiftKey) angle = Math.round(angle / 15) * 15;
    const element = elementById(state.selectedIds[0]); if (element) element.rotation = (interaction.original.rotation || 0) + angle;
    render();
  }

  function handlePointerDown(event) {
    if (event.button !== 0) return;
    const point = snapPoint(clientToSvg(event), event); document.getElementById('cursor-position').textContent = `X ${Math.round(point.x)} · Y ${Math.round(point.y)}`;
    if (state.spacePanning) { state.panStart = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop }; viewport.setPointerCapture(event.pointerId); return; }
    const target = event.target.closest?.('[data-element-id]');
    if (state.tool === 'select') {
      const handle = event.target.dataset.handle;
      if (handle === 'rotate') { beginRotate(point); }
      else if (handle) { beginResize(point, handle); }
      else if (target) { const id = target.dataset.elementId; if (!state.selectedIds.includes(id)) select(id, event.shiftKey); beginMove(point); }
      else select(null);
      viewport.setPointerCapture(event.pointerId); return;
    }
    if (state.tool === 'text') { createTextAt(point); return; }
    if (state.tool === 'pen') { addPenPoint(point, event); return; }
    beginShape(point, event); viewport.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event) {
    const point = clientToSvg(event); document.getElementById('cursor-position').textContent = `X ${Math.round(point.x)} · Y ${Math.round(point.y)}`;
    if (state.panStart) { viewport.scrollLeft = state.panStart.left - (event.clientX - state.panStart.x); viewport.scrollTop = state.panStart.top - (event.clientY - state.panStart.y); return; }
    if (!state.interaction) return;
    if (state.interaction.kind === 'draw') updateShape(point, event); else if (state.interaction.kind === 'move') updateMove(point, event); else if (state.interaction.kind === 'resize') updateResize(point, event); else if (state.interaction.kind === 'rotate') updateRotate(point, event);
  }

  function handlePointerUp(event) {
    if (state.panStart) { state.panStart = null; return; }
    const interaction = state.interaction; if (!interaction) return;
    if (interaction.kind === 'draw') finishShape(); else if (interaction.moved) { pushHistory(); state.interaction = null; render(); } else { state.interaction = null; }
  }

  function addPenPoint(point, event) {
    const snapped = snapPoint(point, event); state.penPoints.push(snapped); renderDraft();
    if (state.penPoints.length > 2 && event.detail >= 2) finishPen();
  }

  function finishPen() {
    if (state.penPoints.length < 2) return;
    const style = defaultStyle(); const element = { id: uid('path'), type: 'path', name: '路径', points: clone(state.penPoints), closed: false, rotation: 0, ...style, visible: true, locked: false };
    state.doc.elements.push(element); state.selectedIds = [element.id]; state.penPoints = []; pushHistory(); render();
  }

  function createTextAt(point) {
    const element = makeElement('text', point); state.doc.elements.push(element); state.selectedIds = [element.id]; pushHistory(); render(); openTextEditor(element, point);
  }

  function openTextEditor(element, point) {
    state.textEditingId = element.id; textEditorInput.value = element.text; textEditor.hidden = false;
    const rect = svg.getBoundingClientRect(); textEditor.style.left = `${Math.min(window.innerWidth - 260, rect.left + point.x * rect.width / state.doc.width + 14)}px`; textEditor.style.top = `${Math.min(window.innerHeight - 150, rect.top + point.y * rect.height / state.doc.height + 14)}px`; textEditorInput.focus(); textEditorInput.select();
  }

  function closeTextEditor(apply) {
    const element = elementById(state.textEditingId); if (element && apply) { const value = textEditorInput.value.trim(); if (value) { element.text = value; element.name = value.slice(0, 18); pushHistory(); render(); } }
    state.textEditingId = null; textEditor.hidden = true;
  }

  function deleteSelected() {
    if (!state.selectedIds.length) return;
    const deletable = new Set(selectedElements().filter(canEditElement).map((element) => element.id));
    if (!deletable.size) return;
    state.doc.elements = state.doc.elements.filter((element) => !deletable.has(element.id)); state.selectedIds = state.selectedIds.filter((id) => !deletable.has(id)); pushHistory(); render();
  }

  function duplicateSelected() {
    const selected = selectedElements(); if (!selected.length) return;
    const copies = selected.filter(canEditElement).map((element) => { const copy = clone(element); copy.id = uid(element.type); copy.name = `${element.name || typeLabel(element.type)} 副本`; if (copy.type === 'rect' || copy.type === 'image') { copy.x += 18; copy.y += 18; } else if (copy.type === 'ellipse') { copy.cx += 18; copy.cy += 18; } else if (copy.type === 'line') { copy.x1 += 18; copy.x2 += 18; copy.y1 += 18; copy.y2 += 18; } else if (copy.type === 'text') { copy.x += 18; copy.y += 18; } else copy.points = copy.points.map((point) => ({ x: point.x + 18, y: point.y + 18 })); return copy; });
    if (!copies.length) return;
    state.doc.elements.push(...copies); state.selectedIds = copies.map((element) => element.id); pushHistory(); render();
  }

  function nudge(dx, dy) { const selected = selectedElements(); if (!selected.length) return; const movable = selected.filter(canEditElement); if (!movable.length) return; movable.forEach((element) => applyDelta(element, element, dx, dy)); pushHistory(); render(); }

  function reorder(direction) {
    if (state.selectedIds.length !== 1) return;
    const index = state.doc.elements.findIndex((element) => element.id === state.selectedIds[0]); if (index < 0 || !canEditElement(state.doc.elements[index])) return;
    const next = direction === 'front' ? Math.min(state.doc.elements.length - 1, index + 1) : Math.max(0, index - 1); if (next === index) return;
    const [element] = state.doc.elements.splice(index, 1); state.doc.elements.splice(next, 0, element); pushHistory(); render();
  }

  function applyProperty(field, value) {
    const selected = selectedElements(); if (!selected.length) return;
    selected.forEach((element) => { if (!canEditElement(element)) return; if (field === 'name') element.name = value || typeLabel(element.type); else if (field === 'fill' || field === 'stroke') element[field] = value || 'none'; else if (field === 'strokeWidth') element.strokeWidth = clamp(num(value), 0, 100); else if (field === 'opacity') element.opacity = clamp(num(value, 1), 0, 1); else if (field === 'text') element.text = value; else if (field === 'fontSize') element.fontSize = clamp(num(value, 42), 6, 300); else if (field === 'fontWeight') element.fontWeight = value; });
    pushHistory(); render();
  }

  function elementSvgString(element) {
    const transform = transformFor(element); const attrs = `fill="${esc(element.fill || 'none')}" stroke="${esc(element.stroke || 'none')}" stroke-width="${num(element.strokeWidth)}" opacity="${num(element.opacity, 1)}"${transform ? ` transform="${esc(transform)}"` : ''}`;
    const hidden = element.visible === false ? ' display="none"' : '';
    const locked = element.locked ? ' data-locked="true"' : '';
    if (element.type === 'rect') return `<rect id="${esc(element.id)}" x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" ${attrs}${locked}${hidden}/>`;
    if (element.type === 'ellipse') return `<ellipse id="${esc(element.id)}" cx="${element.cx}" cy="${element.cy}" rx="${element.rx}" ry="${element.ry}" ${attrs}${locked}${hidden}/>`;
    if (element.type === 'line') return `<line id="${esc(element.id)}" x1="${element.x1}" y1="${element.y1}" x2="${element.x2}" y2="${element.y2}" ${attrs}${locked}${hidden}/>`;
    if (element.type === 'image') return `<image id="${esc(element.id)}" x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" preserveAspectRatio="${esc(element.preserveAspectRatio || 'none')}" href="${esc(element.href)}"${transform ? ` transform="${esc(transform)}"` : ''}${locked}${hidden}/>`;
    if (element.type === 'path') return `<path id="${esc(element.id)}" d="${esc(pointsToD(element.points, element.closed))}" ${attrs}${locked}${hidden}/>`;
    if (element.type === 'text') return `<text id="${esc(element.id)}" x="${element.x}" y="${element.y}" fill="${esc(element.fill)}" stroke="${esc(element.stroke || 'none')}" stroke-width="${num(element.strokeWidth)}" opacity="${num(element.opacity, 1)}" font-size="${num(element.fontSize, 42)}" font-family="${esc(element.fontFamily)}" font-weight="${num(element.fontWeight, 400)}"${element.textAnchor ? ` text-anchor="${esc(element.textAnchor)}"` : ''}${transform ? ` transform="${esc(transform)}"` : ''}${locked}${hidden}>${esc(element.text)}</text>`;
    return '';
  }

  function createSvgString() {
    const groups = state.doc.groups || [];
    const childNodes = (parentId) => [...groups.filter((group) => (group.parentId || null) === (parentId || null)).map((item) => ({ kind: 'group', item })), ...state.doc.elements.filter((element) => (element.groupId || null) === (parentId || null)).map((item) => ({ kind: 'element', item }))].sort((a, b) => {
      const orderA = Number.isFinite(a.item.order) ? a.item.order : Number.MAX_SAFE_INTEGER;
      const orderB = Number.isFinite(b.item.order) ? b.item.order : Number.MAX_SAFE_INTEGER;
      return orderA - orderB;
    });
    const serializeGroup = (group) => { const children = childNodes(group.id).map((child) => child.kind === 'group' ? serializeGroup(child.item) : elementSvgString(child.item)).join(''); const hidden = group.visible === false ? ' display="none"' : ''; return `<g id="${esc(group.id)}" data-vectorlite-group="true" data-name="${esc(group.name || '分组')}"${group.locked ? ' data-locked="true"' : ''}${hidden}>${children}</g>`; };
    const parts = [`<svg xmlns="${SVG_NS}" width="${state.doc.width}" height="${state.doc.height}" viewBox="0 0 ${state.doc.width} ${state.doc.height}">`, `<rect width="${state.doc.width}" height="${state.doc.height}" fill="${esc(state.doc.background)}"/>`];
    parts.push(...childNodes(null).map((child) => child.kind === 'group' ? serializeGroup(child.item) : elementSvgString(child.item)), '</svg>'); return parts.join('');
  }

  function download(blob, filename) { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

  function saveSvg() { state.isDirty = false; const filename = state.doc.name.toLowerCase().endsWith('.svg') ? state.doc.name : `${state.doc.name}.svg`; download(new Blob([createSvgString()], { type: 'image/svg+xml;charset=utf-8' }), filename); updateDocumentState(); showToast('SVG 已保存'); }

  function exportPng() {
    const image = new Image(); const url = URL.createObjectURL(new Blob([createSvgString()], { type: 'image/svg+xml;charset=utf-8' }));
    image.onload = () => { const canvas = document.createElement('canvas'); canvas.width = state.doc.width * 2; canvas.height = state.doc.height * 2; const context = canvas.getContext('2d'); context.scale(2, 2); context.drawImage(image, 0, 0); canvas.toBlob((blob) => download(blob, `${state.doc.name.replace(/\.svg$/i, '')}.png`), 'image/png'); URL.revokeObjectURL(url); showToast('PNG 已导出'); }; image.onerror = () => { URL.revokeObjectURL(url); showToast('PNG 导出失败'); }; image.src = url;
  }

  function parseLength(value, fallback = 0) {
    const match = String(value ?? '').match(/-?\d*\.?\d+(?:e[-+]?\d+)?/i);
    return match ? num(match[0], fallback) : fallback;
  }

  function parseNumberList(value) { return String(value || '').trim().split(/[\s,]+/).filter(Boolean).map((item) => parseLength(item, 0)); }

  function multiplyMatrix(first, second) {
    return [
      first[0] * second[0] + first[2] * second[1],
      first[1] * second[0] + first[3] * second[1],
      first[0] * second[2] + first[2] * second[3],
      first[1] * second[2] + first[3] * second[3],
      first[0] * second[4] + first[2] * second[5] + first[4],
      first[1] * second[4] + first[3] * second[5] + first[5]
    ];
  }

  function parseSvgTransform(value) {
    let result = [1, 0, 0, 1, 0, 0];
    const pattern = /([a-z]+)\s*\(([^)]*)\)/gi;
    let match;
    while ((match = pattern.exec(value || ''))) {
      const name = match[1].toLowerCase(); const values = parseNumberList(match[2]); let matrix = [1, 0, 0, 1, 0, 0];
      if (name === 'matrix' && values.length >= 6) matrix = values.slice(0, 6);
      else if (name === 'translate') matrix = [1, 0, 0, 1, values[0] || 0, values[1] || 0];
      else if (name === 'scale') matrix = [values[0] || 1, 0, 0, values.length > 1 ? values[1] : (values[0] || 1), 0, 0];
      else if (name === 'rotate') {
        const angle = (values[0] || 0) * Math.PI / 180; const cos = Math.cos(angle); const sin = Math.sin(angle); matrix = [cos, sin, -sin, cos, 0, 0];
        if (values.length >= 3) { const around = [1, 0, 0, 1, values[1], values[2]]; const back = [1, 0, 0, 1, -values[1], -values[2]]; matrix = multiplyMatrix(multiplyMatrix(around, matrix), back); }
      } else if (name === 'skewx') matrix = [1, 0, Math.tan((values[0] || 0) * Math.PI / 180), 1, 0, 0];
      else if (name === 'skewy') matrix = [1, Math.tan((values[0] || 0) * Math.PI / 180), 0, 1, 0, 0];
      result = multiplyMatrix(result, matrix);
    }
    return result;
  }

  function matrixString(matrix) {
    if (matrix.every((value, index) => Math.abs(value - [1, 0, 0, 1, 0, 0][index]) < 0.000001)) return '';
    return `matrix(${matrix.map((value) => Number(value.toFixed(6))).join(' ')})`;
  }

  function mergeSvgStyle(node, parent) {
    const style = { ...parent };
    const parentOpacity = parent.opacity ?? 1; let hasLocalOpacity = false;
    const attrs = { fill: 'fill', stroke: 'stroke', strokeWidth: 'stroke-width', opacity: 'opacity', fontSize: 'font-size', fontFamily: 'font-family', fontWeight: 'font-weight', textAnchor: 'text-anchor', display: 'display', visibility: 'visibility' };
    Object.entries(attrs).forEach(([key, attr]) => { if (node.hasAttribute(attr)) { style[key] = node.getAttribute(attr); if (key === 'opacity') hasLocalOpacity = true; } });
    const inlineStyle = node.getAttribute('style') || '';
    inlineStyle.split(';').forEach((declaration) => { const [key, ...rest] = declaration.split(':'); if (!key || !rest.length) return; const cssKey = key.trim().toLowerCase(); const value = rest.join(':').trim(); const mapped = Object.entries(attrs).find(([, attr]) => attr === cssKey)?.[0]; if (mapped) { style[mapped] = value; if (mapped === 'opacity') hasLocalOpacity = true; } });
    style.opacity = clamp(parentOpacity * (hasLocalOpacity ? num(style.opacity, 1) : 1), 0, 1);
    style.strokeWidth = num(style.strokeWidth, 0); style.fontSize = parseLength(style.fontSize, 42); style.fontWeight = num(style.fontWeight, 400);
    return style;
  }

  function isSvgNodeHidden(node) {
    let display = node.getAttribute('display') || '';
    let visibility = node.getAttribute('visibility') || '';
    let opacity = node.hasAttribute('opacity') ? num(node.getAttribute('opacity'), 1) : 1;
    const inlineStyle = node.getAttribute('style') || '';
    inlineStyle.split(';').forEach((declaration) => {
      const [key, ...rest] = declaration.split(':'); if (!key || !rest.length) return;
      const value = rest.join(':').trim();
      if (key.trim().toLowerCase() === 'display') display = value;
      if (key.trim().toLowerCase() === 'visibility') visibility = value;
      if (key.trim().toLowerCase() === 'opacity') opacity = num(value, 1);
    });
    return display.trim().toLowerCase() === 'none' || visibility.trim().toLowerCase() === 'hidden' || opacity <= 0;
  }

  function firstChildByTag(node, tag) { return [...node.children].find((child) => child.tagName.toLowerCase() === tag) || null; }

  function loadSvgText(text, filename) {
    const parser = new DOMParser(); const doc = parser.parseFromString(text, 'image/svg+xml'); if (doc.querySelector('parsererror') || doc.documentElement.nodeName.toLowerCase() !== 'svg') throw new Error('不是有效的 SVG 文件');
    const root = doc.documentElement; const viewBox = parseNumberList(root.getAttribute('viewBox')); const width = parseLength(root.getAttribute('width'), viewBox[2] || 1200); const height = parseLength(root.getAttribute('height'), viewBox[3] || 800);
    const next = { width, height, background: '#ffffff', name: filename || '导入.svg', groups: [], elements: [] };
    const initialStyle = { fill: '#8b5cf6', stroke: 'none', strokeWidth: 0, opacity: 1, fontSize: 42, fontFamily: 'Inter, Segoe UI, sans-serif', fontWeight: 400, textAnchor: 'start', display: '', visibility: '' };
    const identity = [1, 0, 0, 1, 0, 0];
    const childOrder = new Map();
    const nextChildOrder = (parentId, count = 1) => { const key = parentId || '__root__'; const order = childOrder.get(key) || 0; childOrder.set(key, order + count); return order; };
    root.querySelectorAll('script').forEach((node) => node.remove());
    root.querySelectorAll('*').forEach((node) => [...node.attributes].forEach((attribute) => { if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name); }));

    function walk(node, parentMatrix, parentStyle, hiddenByParent, parentGroupId = null) {
      const tag = node.tagName.toLowerCase();
      if (['defs', 'metadata', 'title', 'desc', 'style', 'namedview'].includes(tag)) return;
      const style = mergeSvgStyle(node, parentStyle); const matrix = multiplyMatrix(parentMatrix, parseSvgTransform(node.getAttribute('transform'))); const ownHidden = isSvgNodeHidden(node); const hidden = hiddenByParent || ownHidden;
      let currentGroupId = parentGroupId;
      if (tag === 'g') {
        const sourceId = node.getAttribute('id') || '';
        let groupId = sourceId || uid('group');
        if (next.groups.some((group) => group.id === groupId)) groupId = uid('group');
        const label = node.getAttribute('data-name') || node.getAttribute('aria-label') || node.getAttributeNS('http://www.inkscape.org/namespaces/inkscape', 'label') || sourceId || '分组';
        next.groups.push({ id: groupId, sourceId, name: label, parentId: parentGroupId, order: nextChildOrder(parentGroupId), expanded: true, visible: !ownHidden, locked: node.getAttribute('data-locked') === 'true' });
        currentGroupId = groupId;
      }
      if (['svg', 'g', 'switch'].includes(tag)) { [...node.children].forEach((child) => walk(child, matrix, style, hidden, currentGroupId)); return; }
      const common = { id: node.getAttribute('id') || uid(tag), name: node.getAttribute('id') || typeLabel(tag), groupId: currentGroupId, order: nextChildOrder(currentGroupId), fill: node.getAttribute('fill') || style.fill || (tag === 'path' ? 'none' : '#8b5cf6'), stroke: node.getAttribute('stroke') || style.stroke || 'none', strokeWidth: style.strokeWidth, opacity: style.opacity, visible: !ownHidden, locked: node.getAttribute('data-locked') === 'true', rotation: 0, transform: matrixString(matrix) };
      if (tag === 'rect') next.elements.push({ ...common, type: 'rect', x: parseLength(node.getAttribute('x')), y: parseLength(node.getAttribute('y')), width: parseLength(node.getAttribute('width'), 1), height: parseLength(node.getAttribute('height'), 1), rx: parseLength(node.getAttribute('rx')) });
      else if (tag === 'ellipse') next.elements.push({ ...common, type: 'ellipse', cx: parseLength(node.getAttribute('cx')), cy: parseLength(node.getAttribute('cy')), rx: parseLength(node.getAttribute('rx'), 1), ry: parseLength(node.getAttribute('ry'), 1) });
      else if (tag === 'line') next.elements.push({ ...common, type: 'line', x1: parseLength(node.getAttribute('x1')), y1: parseLength(node.getAttribute('y1')), x2: parseLength(node.getAttribute('x2')), y2: parseLength(node.getAttribute('y2')) });
      else if (tag === 'path') { const points = parsePathPoints(node.getAttribute('d') || ''); if (points.length >= 2) next.elements.push({ ...common, type: 'path', points, closed: /z/i.test(node.getAttribute('d') || '') }); }
      else if (tag === 'image') {
        const href = node.getAttribute('href') || node.getAttribute('xlink:href') || node.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
        if (/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(href)) next.elements.push({ ...common, type: 'image', name: node.getAttribute('id') || '图片', x: parseLength(node.getAttribute('x')), y: parseLength(node.getAttribute('y')), width: parseLength(node.getAttribute('width'), 1), height: parseLength(node.getAttribute('height'), 1), preserveAspectRatio: node.getAttribute('preserveAspectRatio') || 'none', href, fill: 'none', stroke: 'none', strokeWidth: 0 });
      } else if (tag === 'text') {
        const tspans = [...node.children].filter((child) => child.tagName.toLowerCase() === 'tspan');
        const baseName = node.getAttribute('data-name') || node.getAttribute('id') || '文字';
        const baseX = parseLength(node.getAttribute('x'), 0); let cursorY = parseLength(node.getAttribute('y'), 0);
        const textItems = tspans.length ? tspans : [node];
        if (textItems.length > 1) nextChildOrder(currentGroupId, textItems.length - 1);
        textItems.forEach((textNode, index) => {
          const itemStyle = mergeSvgStyle(textNode === node ? node : textNode, style);
          const x = parseLength(textNode.getAttribute('x'), baseX);
          if (textNode.hasAttribute('y')) cursorY = parseLength(textNode.getAttribute('y'), cursorY);
          else cursorY += parseLength(textNode.getAttribute('dy'), 0);
          const textValue = textNode === node ? (node.textContent || '') : (textNode.textContent || '');
          if (!textValue) return;
          next.elements.push({ ...common, order: common.order + index, id: `${common.id}-${index + 1}`, type: 'text', name: textNode.getAttribute('data-name') || `${baseName} ${index + 1}`, x, y: cursorY, text: textValue, fill: textNode.getAttribute('fill') || itemStyle.fill || common.fill, stroke: textNode.getAttribute('stroke') || itemStyle.stroke || common.stroke, strokeWidth: itemStyle.strokeWidth, opacity: itemStyle.opacity, fontSize: parseLength(textNode.getAttribute('font-size'), itemStyle.fontSize), fontFamily: textNode.getAttribute('font-family') || itemStyle.fontFamily, fontWeight: num(textNode.getAttribute('font-weight'), itemStyle.fontWeight), textAnchor: textNode.getAttribute('text-anchor') || itemStyle.textAnchor });
        });
      }
    }

    walk(root, identity, initialStyle, false, null);
    state.doc = next; state.selectedIds = []; state.history = [snapshot()]; state.historyIndex = 0; state.isDirty = false; render(); fitCanvas(); showToast(`已打开 ${filename || 'SVG 文件'} · ${next.elements.length} 个对象`);
  }

  function parsePathPoints(d) { const matches = d.match(/[ML]\s*(-?\d*\.?\d+)[,\s]+(-?\d*\.?\d+)/gi) || []; return matches.map((match) => { const parts = match.slice(1).trim().split(/[,\s]+/); return { x: num(parts[0]), y: num(parts[1]) }; }); }

  function newDocument() { if (state.isDirty && !window.confirm('当前文档有未保存修改，确定新建吗？')) return; state.doc = structuredClone(DEFAULT_DOC); state.selectedIds = []; state.history = [snapshot()]; state.historyIndex = 0; state.isDirty = false; render(); showToast('已新建文档'); }

  function fitCanvas() { const availableWidth = viewport.clientWidth - 100; const availableHeight = viewport.clientHeight - 100; state.zoom = clamp(Math.min(availableWidth / state.doc.width, availableHeight / state.doc.height), .2, 1.8); document.getElementById('zoom-label').textContent = `${Math.round(state.zoom * 100)}%`; render(); }
  function setZoom(value) { state.zoom = clamp(value, .25, 3); document.getElementById('zoom-label').textContent = `${Math.round(state.zoom * 100)}%`; render(); }

  function showToast(message) { toastEl.textContent = message; toastEl.classList.add('is-visible'); clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), 2400); }

  function showBridgeInfo() { window.alert('原生 .ai 读写将在 Electron 桌面版中通过本机 Illustrator 桥接完成。当前网页原型使用 SVG 作为独立工作格式，并会明确报告不支持的 Illustrator 专有对象。'); }

  function bindEvents() {
    document.querySelectorAll('[data-tool]').forEach((button) => button.addEventListener('click', () => setTool(button.dataset.tool)));
    document.addEventListener('click', (event) => { const action = event.target.closest('[data-action]')?.dataset.action; if (!action) return; if (action === 'new') newDocument(); else if (action === 'open') fileInput.click(); else if (action === 'save') saveSvg(); else if (action === 'export-png') exportPng(); else if (action === 'undo') undo(); else if (action === 'redo') redo(); else if (action === 'delete-selected') deleteSelected(); else if (action === 'bring-front') reorder('front'); else if (action === 'send-back') reorder('back'); else if (action === 'zoom-in') setZoom(state.zoom + .1); else if (action === 'zoom-out') setZoom(state.zoom - .1); else if (action === 'fit') fitCanvas(); else if (action === 'bridge-info') showBridgeInfo(); });
    fileInput.addEventListener('change', () => { const file = fileInput.files[0]; if (!file) return; if (/\.ai$/i.test(file.name)) { showToast('当前网页模式不能直接解析 .ai，请使用 Illustrator 桥接版'); fileInput.value = ''; return; } const reader = new FileReader(); reader.onload = () => { try { loadSvgText(reader.result, file.name); } catch (error) { showToast(error.message || '文件读取失败'); } }; reader.readAsText(file); fileInput.value = ''; });
    viewport.addEventListener('pointerdown', handlePointerDown); viewport.addEventListener('pointermove', handlePointerMove); viewport.addEventListener('pointerup', handlePointerUp); viewport.addEventListener('pointercancel', handlePointerUp);
    viewport.addEventListener('wheel', (event) => { if (!event.ctrlKey && !event.metaKey) return; event.preventDefault(); setZoom(state.zoom + (event.deltaY < 0 ? .08 : -.08)); }, { passive: false });
    document.addEventListener('keydown', handleKeyDown); document.addEventListener('keyup', (event) => { if (event.code === 'Space') { state.spacePanning = false; viewport.style.cursor = state.tool === 'select' ? 'default' : 'crosshair'; } });
    document.getElementById('layers-list').addEventListener('click', (event) => {
      const groupToggle = event.target.closest('[data-toggle-group]');
      const groupVisibility = event.target.closest('[data-toggle-group-visibility]');
      const groupLock = event.target.closest('[data-toggle-group-lock]');
      const visibility = event.target.closest('[data-toggle-visibility]');
      const lock = event.target.closest('[data-toggle-lock]');
      const groupRow = event.target.closest('[data-group-id]');
      const row = event.target.closest('[data-layer-id]');
      if (groupToggle) { const group = groupById(groupToggle.dataset.toggleGroup); if (group) { group.expanded = group.expanded === false; renderLayers(); } return; }
      if (groupVisibility) { const group = groupById(groupVisibility.dataset.toggleGroupVisibility); if (group) { group.visible = group.visible === false; state.selectedIds = state.selectedIds.filter((id) => canEditElement(elementById(id))); pushHistory(); render(); } return; }
      if (groupLock) { const group = groupById(groupLock.dataset.toggleGroupLock); if (group) { group.locked = !group.locked; pushHistory(); render(); } return; }
      if (visibility) { const item = elementById(visibility.dataset.toggleVisibility); if (item) { item.visible = item.visible === false; if (!item.visible) state.selectedIds = state.selectedIds.filter((id) => id !== item.id); pushHistory(); render(); } return; }
      if (lock) { const item = elementById(lock.dataset.toggleLock); if (item) { item.locked = !item.locked; pushHistory(); render(); } return; }
      if (groupRow) { selectGroup(groupRow.dataset.groupId, event.shiftKey); return; }
      if (row) select(row.dataset.layerId, event.shiftKey);
    });
    const propertyMap = { 'prop-name': 'name', 'prop-fill': 'fill', 'prop-fill-text': 'fill', 'prop-stroke': 'stroke', 'prop-stroke-text': 'stroke', 'prop-stroke-width': 'strokeWidth', 'prop-opacity': 'opacity', 'prop-text': 'text', 'prop-font-size': 'fontSize', 'prop-font-weight': 'fontWeight' };
    document.getElementById('property-form').addEventListener('change', (event) => { const field = propertyMap[event.target.id]; if (field) applyProperty(field, event.target.value); });
    document.getElementById('property-form').addEventListener('input', (event) => { const field = propertyMap[event.target.id]; if (field && (field === 'fill' || field === 'stroke')) applyProperty(field, event.target.value); });
    document.getElementById('prop-opacity').addEventListener('input', (event) => { document.getElementById('prop-opacity-value').textContent = `${Math.round(Number(event.target.value) * 100)}%`; });
    textEditor.addEventListener('click', (event) => { const action = event.target.closest('[data-text-action]')?.dataset.textAction; if (action === 'apply') closeTextEditor(true); if (action === 'cancel') closeTextEditor(false); });
    textEditorInput.addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) closeTextEditor(true); if (event.key === 'Escape') closeTextEditor(false); });
  }

  function handleKeyDown(event) {
    const tag = document.activeElement?.tagName?.toLowerCase(); if (['input', 'textarea', 'select'].includes(tag)) return;
    if (event.code === 'Space') { state.spacePanning = true; viewport.style.cursor = 'grab'; event.preventDefault(); return; }
    if (modKey(event) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
    if (modKey(event) && event.key.toLowerCase() === 's') { event.preventDefault(); saveSvg(); return; }
    if (modKey(event) && event.key.toLowerCase() === 'o') { event.preventDefault(); fileInput.click(); return; }
    if (modKey(event) && event.key.toLowerCase() === 'n') { event.preventDefault(); newDocument(); return; }
    if (modKey(event) && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicateSelected(); return; }
    if (event.key === 'Delete' || event.key === 'Backspace') { deleteSelected(); return; }
    if (event.key === 'Escape') { state.penPoints = []; state.interaction = null; select(null); render(); return; }
    if (event.key === 'Enter' && state.tool === 'pen') { finishPen(); return; }
    const tools = { v: 'select', r: 'rect', o: 'ellipse', l: 'line', p: 'pen', t: 'text' }; if (tools[event.key.toLowerCase()]) { setTool(tools[event.key.toLowerCase()]); return; }
    const step = event.shiftKey ? 10 : 1; if (event.key === 'ArrowLeft') nudge(-step, 0); if (event.key === 'ArrowRight') nudge(step, 0); if (event.key === 'ArrowUp') nudge(0, -step); if (event.key === 'ArrowDown') nudge(0, step);
  }

  bindEvents(); state.history = [snapshot()]; render(); setTimeout(fitCanvas, 0);
})();
