(function (global) {
  'use strict';

  const SPATIAL_DECLARATIONS = new Set([
    'spatial',
    'front-limit',
    'position',
    'inset',
    'inset-top',
    'inset-right',
    'inset-bottom',
    'inset-left',
    'inset-front',
    'inset-back',
    'top',
    'right',
    'bottom',
    'left',
    'width',
    'height',
    'portal-stage',
    'portal-transform',
    'portal-action',
  ]);

  const DEFAULT_OPTIONS = {
    canvasId: 'spatial-css-polyfill-canvas',
    debug: false,
    far: 10,
    frontLimit: '5cm',
    maxDevicePixelRatio: 2,
    metersPerCssPx: 0.0254 / 96,
    near: 0.01,
    pageDistance: 0.65,
    zIndex: 2147483646,
  };

  const LENGTH_UNITS_TO_PX = {
    px: 1,
    in: 96,
    cm: 96 / 2.54,
    mm: 96 / 25.4,
    q: 96 / 101.6,
    pt: 96 / 72,
    pc: 16,
  };

  const PLACEHOLDER_PROPERTIES = [
    'align-self',
    'flex',
    'flex-basis',
    'flex-grow',
    'flex-shrink',
    'grid-area',
    'grid-column',
    'grid-row',
    'justify-self',
    'order',
  ];

  function waitForDocumentReady() {
    if (document.readyState !== 'loading') {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      document.addEventListener('DOMContentLoaded', resolve, {once: true});
    });
  }

  function stripComments(cssText) {
    return cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  }

  function findMatchingBrace(cssText, openIndex) {
    let depth = 0;
    let quote = '';

    for (let i = openIndex; i < cssText.length; i++) {
      const char = cssText[i];
      const previous = cssText[i - 1];

      if (quote) {
        if (char === quote && previous !== '\\') {
          quote = '';
        }
        continue;
      }

      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }

      if (char === '{') {
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0) {
          return i;
        }
      }
    }

    return -1;
  }

  function splitSelectorList(selectorText) {
    const selectors = [];
    let start = 0;
    let depth = 0;
    let quote = '';

    for (let i = 0; i < selectorText.length; i++) {
      const char = selectorText[i];
      const previous = selectorText[i - 1];

      if (quote) {
        if (char === quote && previous !== '\\') {
          quote = '';
        }
        continue;
      }

      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }

      if (char === '(' || char === '[') {
        depth++;
      } else if (char === ')' || char === ']') {
        depth = Math.max(0, depth - 1);
      } else if (char === ',' && depth === 0) {
        selectors.push(selectorText.slice(start, i).trim());
        start = i + 1;
      }
    }

    selectors.push(selectorText.slice(start).trim());
    return selectors.filter(Boolean);
  }

  function parseDeclarations(blockText) {
    const declarations = [];
    let start = 0;
    let depth = 0;
    let quote = '';

    function pushDeclaration(end) {
      const declaration = blockText.slice(start, end).trim();
      start = end + 1;
      if (!declaration || declaration.includes('{')) {
        return;
      }

      const colonIndex = declaration.indexOf(':');
      if (colonIndex === -1) {
        return;
      }

      const property = declaration.slice(0, colonIndex).trim().toLowerCase();
      if (!SPATIAL_DECLARATIONS.has(property)) {
        return;
      }

      let value = declaration.slice(colonIndex + 1).trim();
      const important = /\s*!important\s*$/i.test(value);
      value = value.replace(/\s*!important\s*$/i, '').trim();
      declarations.push({important, property, value});
    }

    for (let i = 0; i < blockText.length; i++) {
      const char = blockText[i];
      const previous = blockText[i - 1];

      if (quote) {
        if (char === quote && previous !== '\\') {
          quote = '';
        }
        continue;
      }

      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }

      if (char === '(' || char === '[') {
        depth++;
      } else if (char === ')' || char === ']') {
        depth = Math.max(0, depth - 1);
      } else if (char === ';' && depth === 0) {
        pushDeclaration(i);
      }
    }

    pushDeclaration(blockText.length);
    return declarations;
  }

  function parseCssLength(value, percentageBasis = 0, fallback = 0) {
    if (value === undefined || value === null) {
      return fallback;
    }

    const normalized = String(value).trim().toLowerCase();
    if (!normalized || normalized === 'auto' || normalized === 'none') {
      return fallback;
    }

    if (normalized === 'max') {
      return fallback;
    }

    const number = Number.parseFloat(normalized);
    if (!Number.isFinite(number)) {
      return fallback;
    }

    if (normalized.endsWith('%')) {
      return percentageBasis * number / 100;
    }

    const unitMatch = normalized.match(/[a-z]+$/);
    const unit = unitMatch?.[0] ?? 'px';
    const multiplier = LENGTH_UNITS_TO_PX[unit];
    return multiplier ? number * multiplier : fallback;
  }

  function parseFrontLimitMedia(prelude, options) {
    const query = prelude.replace(/^@media/i, '').trim();
    const match = query.match(/^\(?\s*front-limit\s*([<>]=?|=)\s*([^)]+?)\s*\)?$/i);
    if (!match) {
      return global.matchMedia?.(query).matches ?? false;
    }

    const currentPx = parseCssLength(options.frontLimit, 0, 0);
    const testedPx = parseCssLength(match[2], 0, currentPx);
    switch (match[1]) {
      case '>':
        return currentPx > testedPx;
      case '>=':
        return currentPx >= testedPx;
      case '<':
        return currentPx < testedPx;
      case '<=':
        return currentPx <= testedPx;
      case '=':
        return currentPx === testedPx;
      default:
        return false;
    }
  }

  function parseStylesheetRules(cssText, options, mediaApplies = true, rules = []) {
    const css = stripComments(cssText);
    let index = 0;

    while (index < css.length) {
      const openIndex = css.indexOf('{', index);
      if (openIndex === -1) {
        break;
      }

      const prelude = css.slice(index, openIndex).trim();
      const closeIndex = findMatchingBrace(css, openIndex);
      if (closeIndex === -1) {
        break;
      }

      const body = css.slice(openIndex + 1, closeIndex);
      index = closeIndex + 1;

      if (!prelude) {
        continue;
      }

      if (prelude.startsWith('@media')) {
        parseStylesheetRules(
            body,
            options,
            mediaApplies && parseFrontLimitMedia(prelude, options),
            rules);
        continue;
      }

      if (prelude.startsWith('@') || !mediaApplies) {
        continue;
      }

      const declarations = parseDeclarations(body);
      if (declarations.length === 0) {
        continue;
      }

      for (const selector of splitSelectorList(prelude)) {
        rules.push({declarations, selector});
      }
    }

    return rules;
  }

  function estimateSpecificity(selector) {
    const withoutStrings = selector.replace(/"[^"]*"|'[^']*'/g, '');
    const ids = (withoutStrings.match(/#[\w-]+/g) ?? []).length;
    const classes = (withoutStrings.match(/(\.[\w-]+|\[[^\]]+\]|:[\w-]+)/g) ?? []).length;
    const elements = (withoutStrings.match(/(^|[\s>+~])([a-z][\w-]*)/gi) ?? []).length;
    return ids * 10000 + classes * 100 + elements;
  }

  function declarationWins(next, previous) {
    if (!previous) {
      return true;
    }
    if (next.important !== previous.important) {
      return next.important;
    }
    if (next.specificity !== previous.specificity) {
      return next.specificity > previous.specificity;
    }
    return next.order >= previous.order;
  }

  function toCamelCase(property) {
    return property.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
  }

  function collectElementsForSelector(selector) {
    try {
      return Array.from(document.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  function buildSpatialStyleMap(rules) {
    const byElement = new Map();
    let order = 0;

    for (const rule of rules) {
      const specificity = estimateSpecificity(rule.selector);
      const elements = collectElementsForSelector(rule.selector);

      for (const element of elements) {
        let record = byElement.get(element);
        if (!record) {
          record = {};
          byElement.set(element, record);
        }

        for (const declaration of rule.declarations) {
          const next = {
            important: declaration.important,
            order,
            specificity,
            value: declaration.value,
          };
          if (declarationWins(next, record[declaration.property])) {
            record[declaration.property] = next;
          }
        }
      }

      order++;
    }

    for (const element of document.querySelectorAll('[style]')) {
      const declarations = parseDeclarations(element.getAttribute('style') ?? '');
      if (declarations.length === 0) {
        continue;
      }

      let record = byElement.get(element);
      if (!record) {
        record = {};
        byElement.set(element, record);
      }

      for (const declaration of declarations) {
        const next = {
          important: declaration.important,
          order,
          specificity: 1000000,
          value: declaration.value,
        };
        if (declarationWins(next, record[declaration.property])) {
          record[declaration.property] = next;
        }
      }

      order++;
    }

    const computed = new Map();
    for (const [element, record] of byElement) {
      const style = {};
      for (const [property, declaration] of Object.entries(record)) {
        style[property] = declaration.value;
        style[toCamelCase(property)] = declaration.value;
      }
      computed.set(element, style);
    }

    return computed;
  }

  async function readAuthorStyleTexts() {
    const texts = [];
    for (const style of document.querySelectorAll('style')) {
      texts.push(style.textContent ?? '');
    }

    for (const link of document.querySelectorAll('link[rel~="stylesheet"][href]')) {
      try {
        const url = new URL(link.href, document.baseURI);
        if (url.origin !== location.origin) {
          continue;
        }
        const response = await fetch(url.href);
        if (response.ok) {
          texts.push(await response.text());
        }
      } catch {
        // Cross-origin and file URL stylesheets are intentionally best-effort.
      }
    }

    return texts;
  }

  function parseLengthTokenList(value) {
    return String(value ?? '').trim().split(/\s+/).filter(Boolean);
  }

  function expandBoxValues(tokens) {
    if (tokens.length === 0) {
      return ['auto', 'auto', 'auto', 'auto'];
    }
    if (tokens.length === 1) {
      return [tokens[0], tokens[0], tokens[0], tokens[0]];
    }
    if (tokens.length === 2) {
      return [tokens[0], tokens[1], tokens[0], tokens[1]];
    }
    if (tokens.length === 3) {
      return [tokens[0], tokens[1], tokens[2], tokens[1]];
    }
    return [tokens[0], tokens[1], tokens[2], tokens[3]];
  }

  function readInsetParts(spatialStyle) {
    const inset = spatialStyle.inset;
    const parts = String(inset ?? '').split('/');
    const xyTokens = inset ? expandBoxValues(parseLengthTokenList(parts[0])) : null;
    const zTokens = parts.length > 1 ? parseLengthTokenList(parts.slice(1).join('/')) : [];

    return {
      back: spatialStyle.insetBack ?? zTokens[0] ?? 'auto',
      bottom: spatialStyle.insetBottom ?? spatialStyle.bottom ?? xyTokens?.[2] ?? 'auto',
      front: spatialStyle.insetFront ?? zTokens[1] ?? 'auto',
      left: spatialStyle.insetLeft ?? spatialStyle.left ?? xyTokens?.[3] ?? 'auto',
      right: spatialStyle.insetRight ?? spatialStyle.right ?? xyTokens?.[1] ?? 'auto',
      top: spatialStyle.insetTop ?? spatialStyle.top ?? xyTokens?.[0] ?? 'auto',
    };
  }

  function isAuto(value) {
    return value === undefined || value === null || String(value).trim().toLowerCase() === 'auto';
  }

  function parsePortalStage(style, fallbackBackPx) {
    const stage = style.portalStage ?? '';
    const parts = String(stage).split('/');
    const xy = expandBoxValues(parseLengthTokenList(parts[0]));
    const z = parts.length > 1 ? parseLengthTokenList(parts.slice(1).join('/')) : [];

    return {
      back: parseCssLength(z[0], 0, fallbackBackPx),
      bottom: parseCssLength(xy[2], 0, 0),
      front: parseCssLength(z[1], 0, 0),
      left: parseCssLength(xy[3], 0, 0),
      right: parseCssLength(xy[1], 0, 0),
      top: parseCssLength(xy[0], 0, 0),
    };
  }

  function createPlaceholder(element, rect, isRelative) {
    const computedStyle = getComputedStyle(element);
    const placeholder = document.createElement('span');
    placeholder.setAttribute('aria-hidden', 'true');
    placeholder.dataset.spatialCssPlaceholder = '';

    if (!isRelative) {
      placeholder.style.display = 'none';
      return placeholder;
    }

    let display = computedStyle.display;
    if (display === 'inline') {
      display = 'inline-block';
    }

    placeholder.style.display = display;
    placeholder.style.boxSizing = 'border-box';
    placeholder.style.width = `${rect.width}px`;
    placeholder.style.height = `${rect.height}px`;
    placeholder.style.marginTop = computedStyle.marginTop;
    placeholder.style.marginRight = computedStyle.marginRight;
    placeholder.style.marginBottom = computedStyle.marginBottom;
    placeholder.style.marginLeft = computedStyle.marginLeft;

    for (const property of PLACEHOLDER_PROPERTIES) {
      placeholder.style.setProperty(property, computedStyle.getPropertyValue(property));
    }

    return placeholder;
  }

  function freezeComputedStyles(root) {
    const originalInlineStyles = new Map();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let current = root;

    while (current) {
      originalInlineStyles.set(current, current.getAttribute('style'));
      const computed = getComputedStyle(current);
      for (const property of computed) {
        current.style.setProperty(
            property,
            computed.getPropertyValue(property),
            computed.getPropertyPriority(property));
      }
      current = walker.nextNode();
    }

    return originalInlineStyles;
  }

  function makeShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(log || 'Shader compilation failed');
    }
    return shader;
  }

  function makeProgram(gl, vertexSource, fragmentSource) {
    const program = gl.createProgram();
    gl.attachShader(program, makeShader(gl, gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, makeShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(log || 'Program link failed');
    }
    return program;
  }

  function makeModelMatrix(x, y, z, width, height) {
    return new Float32Array([
      width, 0, 0, 0,
      0, height, 0, 0,
      0, 0, 1, 0,
      x, y, z, 1,
    ]);
  }

  function makePerspectiveMatrix(fovyRadians, aspect, near, far) {
    const f = 1 / Math.tan(fovyRadians / 2);
    const nf = 1 / (near - far);

    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0,
    ]);
  }

  function makeFallbackViewMatrix(eyeOffsetMeters) {
    return new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      -eyeOffsetMeters, 0, 0, 1,
    ]);
  }

  function matrixFromSlice(source, start) {
    if (typeof source.subarray === 'function') {
      return source.subarray(start, start + 16);
    }
    return new Float32Array(source.slice(start, start + 16));
  }

  function multiplyMatrixPoint(matrix, point) {
    const x = point[0];
    const y = point[1];
    const z = point[2];
    const w = point[3];
    return [
      matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12] * w,
      matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13] * w,
      matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14] * w,
      matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15] * w,
    ];
  }

  function projectPoint(viewMatrix, projectionMatrix, x, y, z) {
    const viewPoint = multiplyMatrixPoint(viewMatrix, [x, y, z, 1]);
    const clipPoint = multiplyMatrixPoint(projectionMatrix, viewPoint);
    if (Math.abs(clipPoint[3]) < 0.000001) {
      return null;
    }
    return {
      x: clipPoint[0] / clipPoint[3],
      y: clipPoint[1] / clipPoint[3],
    };
  }

  function estimatePlaneMetersPerCssPx(matrices, canvasRect, fallback) {
    const sampleMeters = 0.01;
    const estimates = [];

    for (const eye of [
      [matrices.leftView, matrices.leftProjection],
      [matrices.rightView, matrices.rightProjection],
    ]) {
      const center = projectPoint(eye[0], eye[1], 0, 0, 0);
      const xSample = projectPoint(eye[0], eye[1], sampleMeters, 0, 0);
      const ySample = projectPoint(eye[0], eye[1], 0, sampleMeters, 0);
      if (!center || !xSample || !ySample) {
        continue;
      }

      const ndcPerMeterX = Math.abs(xSample.x - center.x) / sampleMeters;
      const ndcPerMeterY = Math.abs(ySample.y - center.y) / sampleMeters;
      const metersPerCssPxX = 2 / Math.max(1, canvasRect.width) / ndcPerMeterX;
      const metersPerCssPxY = 2 / Math.max(1, canvasRect.height) / ndcPerMeterY;

      if (Number.isFinite(metersPerCssPxX) && metersPerCssPxX > 0) {
        estimates.push(metersPerCssPxX);
      }
      if (Number.isFinite(metersPerCssPxY) && metersPerCssPxY > 0) {
        estimates.push(metersPerCssPxY);
      }
    }

    return estimates.length > 0 ?
      estimates.reduce((sum, value) => sum + value, 0) / estimates.length :
      fallback;
  }

  function applyCanvasChildLayout(element, rect) {
    element.style.position = 'absolute';
    element.style.boxSizing = 'border-box';
    element.style.left = `${Math.round(rect.left * 1000) / 1000}px`;
    element.style.top = `${Math.round(rect.top * 1000) / 1000}px`;
    element.style.width = `${Math.max(1, Math.round(rect.width * 1000) / 1000)}px`;
    element.style.height = `${Math.max(1, Math.round(rect.height * 1000) / 1000)}px`;
    element.style.margin = '0';
    element.style.transform = 'none';
    element.style.transformOrigin = '50% 50%';
    element.style.pointerEvents = 'auto';
    element.style.willChange = 'transform';
  }

  function rectFromRelativePlaceholder(item, viewportRect) {
    const rect = item.placeholder.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      height: rect.height,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      width: rect.width,
      withinViewport: rect.left < viewportRect.width && rect.top < viewportRect.height &&
          rect.right > 0 && rect.bottom > 0,
    };
  }

  function rectToLocalRect(rect, canvasRect) {
    return {
      bottom: rect.bottom - canvasRect.top,
      height: rect.height,
      left: rect.left - canvasRect.left,
      right: rect.right - canvasRect.left,
      top: rect.top - canvasRect.top,
      width: rect.width,
      withinViewport: rect.withinViewport,
    };
  }

  function rectFromAbsoluteInsets(item, viewportRect) {
    const containerRect = item.container.element.getBoundingClientRect();
    const style = item.spatialStyle;
    const insets = item.insets;
    const measured = item.rect;
    const width = parseCssLength(style.width, containerRect.width, measured.width || 1);
    const height = parseCssLength(style.height, containerRect.height, measured.height || 1);
    const leftInset = parseCssLength(insets.left, containerRect.width, 0);
    const rightInset = parseCssLength(insets.right, containerRect.width, 0);
    const topInset = parseCssLength(insets.top, containerRect.height, 0);
    const bottomInset = parseCssLength(insets.bottom, containerRect.height, 0);

    let left;
    if (!isAuto(insets.left)) {
      left = containerRect.left + leftInset;
    } else if (!isAuto(insets.right)) {
      left = containerRect.right - rightInset - width;
    } else {
      left = containerRect.left + (containerRect.width - width) / 2;
    }

    let top;
    if (!isAuto(insets.top)) {
      top = containerRect.top + topInset;
    } else if (!isAuto(insets.bottom)) {
      top = containerRect.bottom - bottomInset - height;
    } else {
      top = containerRect.top + (containerRect.height - height) / 2;
    }

    return {
      bottom: top + height,
      height,
      left,
      right: left + width,
      top,
      width,
      withinViewport: left < viewportRect.width && top < viewportRect.height &&
          left + width > 0 && top + height > 0,
    };
  }

  function resolveRelativeDepthPx(insets, frontLimitPx, allowBehindPortal) {
    let depthPx = 0;
    if (!isAuto(insets.back)) {
      depthPx = parseCssLength(insets.back, frontLimitPx, 0);
    } else if (!isAuto(insets.front)) {
      depthPx = -parseCssLength(insets.front, frontLimitPx, 0);
    }

    if (depthPx > frontLimitPx) {
      depthPx = frontLimitPx;
    }
    if (!allowBehindPortal && depthPx < 0) {
      depthPx = 0;
    }
    return depthPx;
  }

  function resolveAbsoluteDepthPx(item) {
    const insets = item.insets;
    const frontLimitPx = item.container.frontLimitPx;

    if (item.container.kind === 'portal') {
      const stageBackPx = item.container.stage?.back ?? frontLimitPx;
      const stageFrontPx = item.container.stage?.front ?? 0;
      let depthPx = 0;
      if (!isAuto(insets.back)) {
        depthPx = -stageBackPx + parseCssLength(insets.back, stageBackPx, 0);
      } else if (!isAuto(insets.front)) {
        depthPx = stageFrontPx - parseCssLength(insets.front, stageFrontPx, 0);
      }
      return Math.min(depthPx, frontLimitPx);
    }

    let depthPx = 0;
    if (!isAuto(insets.back)) {
      depthPx = parseCssLength(insets.back, frontLimitPx, 0);
    } else if (!isAuto(insets.front)) {
      depthPx = -parseCssLength(insets.front, frontLimitPx, 0);
    }
    return Math.max(0, Math.min(depthPx, frontLimitPx));
  }

  class SpatialCSSPolyfill {
    constructor(options = {}) {
      this.options = {...DEFAULT_OPTIONS, ...options};
      this.canvas = null;
      this.canvasRect = {
        bottom: 1,
        height: 1,
        left: 0,
        right: 1,
        top: 0,
        width: 1,
      };
      this.contextLost = false;
      this.containers = [];
      this.gl = null;
      this.headTrackedStereo = null;
      this.items = [];
      this.locations = null;
      this.program = null;
      this.rafId = 0;
      this.resizeObserver = null;
      this.spatialStyles = new Map();
      this.vertexArray = null;
    }

    async start() {
      await waitForDocumentReady();

      const styleTexts = await readAuthorStyleTexts();
      const rules = [];
      for (const cssText of styleTexts) {
        parseStylesheetRules(cssText, this.options, true, rules);
      }
      this.spatialStyles = buildSpatialStyleMap(rules);

      this.createCanvas();
      this.createContext();
      this.createProgram();
      this.collectSpatialContent();

      this.canvas.addEventListener('paint', event => {
        const changedElements = event.changedElements ?? [];
        if (changedElements.length === 0) {
          this.markAllTexturesDirty();
          return;
        }

        for (const element of changedElements) {
          const item = this.items.find(candidate => candidate.element === element);
          if (item) {
            item.textureDirty = true;
          }
        }
      });

      this.resizeObserver = new ResizeObserver(() => {
        this.resizeCanvas();
        this.requestTextureRefresh();
      });
      this.resizeObserver.observe(this.canvas, {box: 'device-pixel-content-box'});

      this.resizeCanvas();
      this.requestTextureRefresh();
      this.renderFrame = this.renderFrame.bind(this);
      this.rafId = requestAnimationFrame(this.renderFrame);
    }

    disconnect() {
      cancelAnimationFrame(this.rafId);
      this.resizeObserver?.disconnect();

      for (const item of this.items) {
        item.placeholder?.replaceWith(item.element);
        for (const [element, inlineStyle] of item.originalInlineStyles) {
          if (inlineStyle === null) {
            element.removeAttribute('style');
          } else {
            element.setAttribute('style', inlineStyle);
          }
        }
        item.element.removeAttribute('data-spatial-css-polyfill-element');
      }

      this.canvas?.remove();
    }

    createCanvas() {
      const existing = document.getElementById(this.options.canvasId);
      this.canvas = existing ?? document.createElement('canvas');
      this.canvas.id = this.options.canvasId;
      this.canvas.layoutSubtree = true;
      this.canvas.setAttribute('layoutsubtree', '');
      this.canvas.style.position = 'fixed';
      this.canvas.style.left = '0';
      this.canvas.style.top = '0';
      this.canvas.style.width = '1px';
      this.canvas.style.height = '1px';
      this.canvas.style.background = 'transparent';
      this.canvas.style.display = 'block';
      this.canvas.style.pointerEvents = 'none';
      this.canvas.style.zIndex = String(this.options.zIndex);

      if (!existing) {
        document.body.appendChild(this.canvas);
      }
    }

    createContext() {
      const gl = this.canvas.getContext('webgl2', {
        alpha: true,
        antialias: true,
        desynchronized: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
        stereo: 'side-by-side',
      });

      if (!gl) {
        throw new Error('Spatial CSS polyfill requires a WebGL2 context.');
      }
      if (typeof gl.texElementImage2D !== 'function') {
        throw new Error('Spatial CSS polyfill requires html-in-canvas WebGL texElementImage2D.');
      }
      // if (typeof this.canvas.requestPaint !== 'function') {
      //   throw new Error('Spatial CSS polyfill requires html-in-canvas canvas.requestPaint().');
      // }

      this.gl = gl;
      this.headTrackedStereo =
          gl.getExtension('META_head_tracked_stereo') ??
          gl.getExtension('HORIZON_head_tracked_stereo');

      this.canvas.addEventListener('webglcontextlost', event => {
        event.preventDefault();
        this.contextLost = true;
      });

      this.canvas.addEventListener('webglcontextrestored', () => {
        this.contextLost = false;
        this.createProgram();
        this.requestTextureRefresh();
      });
    }

    createProgram() {
      const gl = this.gl;
      this.program = makeProgram(gl, `#version 300 es
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_texcoord;

uniform mat4 u_projection;
uniform mat4 u_view;
uniform mat4 u_model;

out vec2 v_texcoord;

void main() {
  gl_Position = u_projection * u_view * u_model * vec4(a_position, 0.0, 1.0);
  v_texcoord = a_texcoord;
}
`, `#version 300 es
precision mediump float;

uniform sampler2D u_texture;

in vec2 v_texcoord;
out vec4 output_color;

void main() {
  output_color = texture(u_texture, v_texcoord);
}
`);

      this.locations = {
        model: gl.getUniformLocation(this.program, 'u_model'),
        projection: gl.getUniformLocation(this.program, 'u_projection'),
        texture: gl.getUniformLocation(this.program, 'u_texture'),
        view: gl.getUniformLocation(this.program, 'u_view'),
      };

      const vertices = new Float32Array([
        -0.5, 0.5, 0, 0,
        -0.5, -0.5, 0, 1,
        0.5, 0.5, 1, 0,
        0.5, 0.5, 1, 0,
        -0.5, -0.5, 0, 1,
        0.5, -0.5, 1, 1,
      ]);

      this.vertexArray = gl.createVertexArray();
      gl.bindVertexArray(this.vertexArray);

      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);

      gl.bindVertexArray(null);
      gl.useProgram(this.program);
      gl.uniform1i(this.locations.texture, 0);
    }

    collectSpatialContent() {
      const containerByElement = new Map();
      this.containers = Array.from(this.spatialStyles.entries())
          .filter(([, style]) => style.spatial === 'page' || style.spatial === 'portal')
          .map(([element, style]) => {
            const container = this.makeContainer(element, style);
            containerByElement.set(element, container);
            return container;
          });

      const candidateItems = [];
      for (const [element, spatialStyle] of this.spatialStyles.entries()) {
        const container = this.findNearestContainer(element, containerByElement);
        if (!container || element === container.element) {
          continue;
        }

        const position = spatialStyle.position ?? getComputedStyle(element).position;
        const insets = readInsetParts(spatialStyle);
        const hasZInset = !isAuto(insets.back) || !isAuto(insets.front);
        const isSpatialAbsolute = position === 'spatial-absolute';
        const isRelative = position === 'relative' && hasZInset;
        if (!isSpatialAbsolute && !isRelative) {
          continue;
        }

        candidateItems.push({container, element, insets, isRelative, isSpatialAbsolute, spatialStyle});
      }

      candidateItems.sort((a, b) => {
        if (a.element.contains(b.element)) {
          return -1;
        }
        if (b.element.contains(a.element)) {
          return 1;
        }
        return 0;
      });

      for (const candidate of candidateItems) {
        if (this.items.some(item => item.element.contains(candidate.element))) {
          continue;
        }
        const item = this.makeItem(candidate);
        if (item) {
          this.items.push(item);
        }
      }

      for (const container of this.containers) {
        const fallbackBackPx = this.items
            .filter(item => item.container === container && item.isSpatialAbsolute && !isAuto(item.insets.back))
            .reduce((max, item) => Math.max(max, parseCssLength(item.insets.back, 0, 0)),
                parseCssLength(this.options.frontLimit, 0, 0));
        container.stage = parsePortalStage(container.spatialStyle, fallbackBackPx);
      }

      this.log(`tracking ${this.items.length} spatial element(s)`);
    }

    makeContainer(element, spatialStyle) {
      const frontLimitValue =
          spatialStyle.frontLimit ??
          this.findInheritedSpatialValue(element.parentElement, 'frontLimit') ??
          this.options.frontLimit;
      const defaultFrontLimitPx = parseCssLength(this.options.frontLimit, 0, 0);

      return {
        element,
        frontLimitPx: parseCssLength(frontLimitValue, 0, defaultFrontLimitPx),
        kind: spatialStyle.spatial,
        spatialStyle,
        stage: null,
      };
    }

    findNearestContainer(element, containerByElement) {
      for (let current = element.parentElement; current; current = current.parentElement) {
        const container = containerByElement.get(current);
        if (container) {
          return container;
        }
      }
      return null;
    }

    findInheritedSpatialValue(element, property) {
      for (let current = element; current; current = current.parentElement) {
        const style = this.spatialStyles.get(current);
        if (style?.[property] !== undefined) {
          return style[property];
        }
      }
      return undefined;
    }

    makeItem(candidate) {
      const rect = candidate.element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return null;
      }

      const originalInlineStyles = freezeComputedStyles(candidate.element);
      const placeholder = createPlaceholder(candidate.element, rect, candidate.isRelative);
      candidate.element.before(placeholder);
      this.canvas.appendChild(candidate.element);
      candidate.element.dataset.spatialCssPolyfillElement = '';
      applyCanvasChildLayout(candidate.element, rect);

      const texture = this.gl.createTexture();
      this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
      this.gl.bindTexture(this.gl.TEXTURE_2D, null);

      return {
        ...candidate,
        depthPx: 0,
        modelMatrix: makeModelMatrix(0, 0, -this.options.pageDistance, 1, 1),
        originalInlineStyles,
        placeholder,
        rect: {
          bottom: rect.bottom,
          height: rect.height,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          width: rect.width,
          withinViewport: true,
        },
        texture,
        textureDirty: true,
        textureReady: false,
        uploadErrorLogged: false,
      };
    }

    markAllTexturesDirty() {
      for (const item of this.items) {
        item.textureDirty = true;
        item.uploadErrorLogged = false;
      }
    }

    requestTextureRefresh() {
      this.markAllTexturesDirty();
      // this.canvas.requestPaint();
    }

    resizeCanvas() {
      const dpr = Math.min(global.devicePixelRatio || 1, this.options.maxDevicePixelRatio);
      const width = Math.max(2, Math.round(this.canvasRect.width * dpr));
      const height = Math.max(2, Math.round(this.canvasRect.height * dpr));

      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
    }

    async resolveStereoMatrices() {
      const matrices = await this.headTrackedStereo?.getStereoMatrices(
          this.options.near,
          this.options.far);
      if (matrices) {
        const resolvedMatrices = {
          leftProjection: matrixFromSlice(matrices, 32),
          leftView: matrixFromSlice(matrices, 0),
          pagePlaneZ: 0,
          rightProjection: matrixFromSlice(matrices, 48),
          rightView: matrixFromSlice(matrices, 16),
        };
        resolvedMatrices.planeMetersPerCssPx = estimatePlaneMetersPerCssPx(
            resolvedMatrices,
            this.canvasRect,
            this.options.metersPerCssPx);
        resolvedMatrices.depthMetersPerCssPx = this.options.metersPerCssPx;
        return resolvedMatrices;
      }

      const aspect = Math.max(1, this.canvas.width / 2) / Math.max(1, this.canvas.height);
      const projection = makePerspectiveMatrix(42 * Math.PI / 180, aspect, this.options.near, this.options.far);
      const planeMetersPerCssPx =
        2 * this.options.pageDistance / (projection[5] * Math.max(1, this.canvasRect.height));
      return {
        depthMetersPerCssPx: planeMetersPerCssPx,
        leftProjection: projection,
        leftView: makeFallbackViewMatrix(-0.0315),
        pagePlaneZ: -this.options.pageDistance,
        planeMetersPerCssPx,
        rightProjection: projection,
        rightView: makeFallbackViewMatrix(0.0315),
      };
    }

    measureItemLayout(item) {
      const viewportRect = {
        height: global.innerHeight,
        width: global.innerWidth,
      };
      const rect = item.isSpatialAbsolute ?
        rectFromAbsoluteInsets(item, viewportRect) :
        rectFromRelativePlaceholder(item, viewportRect);

      item.rect = rect;

      item.depthPx = item.isRelative ?
        resolveRelativeDepthPx(item.insets, item.container.frontLimitPx, item.container.kind === 'portal') :
        resolveAbsoluteDepthPx(item);
    }

    updateCanvasBounds() {
      const visibleRects = this.items
          .map(item => item.rect)
          .filter(rect => rect?.withinViewport && rect.width > 0 && rect.height > 0);

      if (visibleRects.length === 0) {
        this.canvas.style.display = 'none';
        this.canvasRect = {
          bottom: 1,
          height: 1,
          left: 0,
          right: 1,
          top: 0,
          width: 1,
        };
        return;
      }

      let left = Infinity;
      let right = -Infinity;
      let top = Infinity;
      let bottom = -Infinity;
      for (const rect of visibleRects) {
        left = Math.min(left, rect.left);
        right = Math.max(right, rect.right);
        top = Math.min(top, rect.top);
        bottom = Math.max(bottom, rect.bottom);
      }

      this.canvasRect = {
        bottom,
        height: Math.max(1, bottom - top),
        left,
        right,
        top,
        width: Math.max(1, right - left),
      };

      this.canvas.style.display = 'block';
      this.canvas.style.left = `${Math.round(left * 1000) / 1000}px`;
      this.canvas.style.top = `${Math.round(top * 1000) / 1000}px`;
      this.canvas.style.width = `${Math.round(this.canvasRect.width * 1000) / 1000}px`;
      this.canvas.style.height = `${Math.round(this.canvasRect.height * 1000) / 1000}px`;
    }

    updateItemLayout(item, matrices) {
      const localRect = rectToLocalRect(item.rect, this.canvasRect);
      applyCanvasChildLayout(item.element, localRect);

      const planeMetersPerCssPx = matrices.planeMetersPerCssPx;
      const depthMetersPerCssPx = matrices.depthMetersPerCssPx;
      const x = (localRect.left + localRect.width / 2 - this.canvasRect.width / 2) * planeMetersPerCssPx;
      const y = (this.canvasRect.height / 2 - localRect.top - localRect.height / 2) * planeMetersPerCssPx;
      const z = matrices.pagePlaneZ + item.depthPx * depthMetersPerCssPx;
      const width = localRect.width * planeMetersPerCssPx;
      const height = localRect.height * planeMetersPerCssPx;
      item.modelMatrix = makeModelMatrix(x, y, z, width, height);
    }

    uploadTexture(item) {
      if (!item.textureDirty) {
        return;
      }

      const gl = this.gl;
      const dpr = Math.min(global.devicePixelRatio || 1, this.options.maxDevicePixelRatio);
      const textureWidth = Math.max(1, Math.ceil(item.rect.width * dpr));
      const textureHeight = Math.max(1, Math.ceil(item.rect.height * dpr));

      gl.bindTexture(gl.TEXTURE_2D, item.texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

      try {
        gl.texElementImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            textureWidth,
            textureHeight,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            item.element);
        item.textureDirty = false;
        item.textureReady = true;
        item.uploadErrorLogged = false;
      } catch (error) {
        try {
          gl.texElementImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, item.element);
          item.textureDirty = false;
          item.textureReady = true;
          item.uploadErrorLogged = false;
        } catch {
          // this.canvas.requestPaint();
          if (!item.uploadErrorLogged) {
            this.log(`texElementImage2D failed for ${item.element.tagName}: ${error.message}`);
            item.uploadErrorLogged = true;
          }
        }
      }
    }

    drawEye(viewMatrix, projectionMatrix, x, width, height) {
      const gl = this.gl;
      gl.viewport(x, 0, width, height);
      gl.scissor(x, 0, width, height);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.uniformMatrix4fv(this.locations.view, false, viewMatrix);
      gl.uniformMatrix4fv(this.locations.projection, false, projectionMatrix);

      for (const item of this.items) {
        if (!item.textureReady || !item.rect.withinViewport || item.rect.width <= 0 || item.rect.height <= 0) {
          continue;
        }

        gl.bindTexture(gl.TEXTURE_2D, item.texture);
        gl.uniformMatrix4fv(this.locations.model, false, item.modelMatrix);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }

    async renderFrame() {
      if (this.contextLost) {
        this.rafId = requestAnimationFrame(this.renderFrame);
        return;
      }

      for (const item of this.items) {
        this.measureItemLayout(item);
      }

      this.updateCanvasBounds();
      this.resizeCanvas();

      const matrices = await this.resolveStereoMatrices();

      for (const item of this.items) {
        this.updateItemLayout(item, matrices);
        this.uploadTexture(item);
      }

      const gl = this.gl;
      const halfWidth = Math.floor(this.canvas.width / 2);
      const height = this.canvas.height;

      gl.useProgram(this.program);
      gl.bindVertexArray(this.vertexArray);
      gl.enable(gl.SCISSOR_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.disable(gl.DEPTH_TEST);
      gl.colorMask(true, true, true, true);
      gl.clearColor(0, 0, 0, 0);
      gl.clearDepth(1);

      this.items.sort((a, b) => a.depthPx - b.depthPx);
      this.drawEye(matrices.leftView, matrices.leftProjection, 0, halfWidth, height);
      this.drawEye(
          matrices.rightView,
          matrices.rightProjection,
          halfWidth,
          this.canvas.width - halfWidth,
          height);

      gl.bindVertexArray(null);
      gl.disable(gl.SCISSOR_TEST);
      this.rafId = requestAnimationFrame(this.renderFrame);
    }

    log(message) {
      if (this.options.debug) {
        console.log(`[SpatialCSSPolyfill] ${message}`);
      }
    }
  }

  async function installSpatialCSSPolyfill(options = {}) {
    const polyfill = new SpatialCSSPolyfill(options);
    await polyfill.start();
    return polyfill;
  }

  global.SpatialCSSPolyfill = SpatialCSSPolyfill;
  global.installSpatialCSSPolyfill = installSpatialCSSPolyfill;
})(globalThis);
