/*!
 * dc-lite: a small runtime that runs a Design Component (.dc.html) page as a normal web page.
 * Written for the Freight Net design previews. Needs React 18 and ReactDOM 18 (UMD) loaded first.
 *
 * Supported template features (the subset the design files use):
 *   {{a.b.0.c}} dotted lookups (text and attributes), "a {{x}} b" string interpolation,
 *   whole-value attributes ({{handler}}, {{ref}}, {{bool}}), <sc-for list as>, <sc-if value>,
 *   hint-* attributes (ignored), JSX-style camelCase event and DOM attribute names.
 *
 * Page contract (written by preview/build.py):
 *   <script type="text/x-dc-template" id="dc-template"> template markup </script>
 *   <script type="application/json" id="dc-props"> {"lang":"en"} </script>
 *   <div id="dc-root"></div>
 *   <script> DCLite.boot(function (DCLogic) { ...class Component extends DCLogic {...}; return Component; }); </script>
 */
(function () {
  'use strict';
  var React = window.React;
  var ReactDOM = window.ReactDOM;
  var h = React.createElement;

  var VOID = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, source: 1, track: 1, wbr: 1 };
  var RAW = { style: 1, script: 1 };
  // children where a whitespace-only text node is not allowed (React would warn or misplace it)
  var NO_WS = { table: 1, thead: 1, tbody: 1, tfoot: 1, tr: 1, colgroup: 1 };

  // HTML attribute names that React spells differently
  var NAME = {
    'class': 'className', 'for': 'htmlFor', tabindex: 'tabIndex', readonly: 'readOnly',
    maxlength: 'maxLength', minlength: 'minLength', autocomplete: 'autoComplete', autofocus: 'autoFocus',
    autocapitalize: 'autoCapitalize', autocorrect: 'autoCorrect', inputmode: 'inputMode', enterkeyhint: 'enterKeyHint',
    novalidate: 'noValidate', formnovalidate: 'formNoValidate', colspan: 'colSpan', rowspan: 'rowSpan',
    crossorigin: 'crossOrigin', srcset: 'srcSet', usemap: 'useMap', datetime: 'dateTime',
    contenteditable: 'contentEditable', spellcheck: 'spellCheck', accesskey: 'accessKey',
    referrerpolicy: 'referrerPolicy', playsinline: 'playsInline', allowfullscreen: 'allowFullScreen',
    frameborder: 'frameBorder', cellpadding: 'cellPadding', cellspacing: 'cellSpacing', enctype: 'encType',
    formaction: 'formAction', hreflang: 'hrefLang', 'accept-charset': 'acceptCharset', 'http-equiv': 'httpEquiv',
    'xlink:href': 'xlinkHref', 'xml:space': 'xmlSpace', 'xml:lang': 'xmlLang', 'xmlns:xlink': 'xmlnsXlink',
    viewbox: 'viewBox', preserveaspectratio: 'preserveAspectRatio'
  };
  // attributes that React treats as booleans: a static attribute that is present means true
  var BOOL = {
    allowFullScreen: 1, async: 1, autoFocus: 1, autoPlay: 1, controls: 1, 'default': 1, defer: 1, disabled: 1,
    formNoValidate: 1, hidden: 1, loop: 1, noValidate: 1, open: 1, playsInline: 1, readOnly: 1, required: 1,
    reversed: 1, itemScope: 1, checked: 1, multiple: 1, muted: 1, selected: 1, inert: 1
  };
  var TEXTLIKE_INPUT = { '': 1, text: 1, email: 1, tel: 1, url: 1, search: 1, password: 1, number: 1, date: 1, time: 1, 'datetime-local': 1, month: 1, week: 1, color: 1, range: 1 };

  /* ---------------- entities ---------------- */
  var decoder = null;
  function decode(s) {
    if (s.indexOf('&') < 0) return s;
    if (!decoder) decoder = document.createElement('textarea');
    decoder.innerHTML = s;
    return decoder.value;
  }

  /* ---------------- holes ---------------- */
  var HOLE = /\{\{\s*([^}]*?)\s*\}\}/g;
  var WHOLE = /^\{\{\s*([^}]*?)\s*\}\}$/; // only an exact {{path}}: "{{x}} " keeps its space
  // text or attribute value -> string, {whole: path} or {parts: [...]}
  function compileValue(raw, decodeIt) {
    var m = WHOLE.exec(raw);
    if (m) return { whole: m[1] };
    if (raw.indexOf('{{') < 0) return decodeIt ? decode(raw) : raw;
    var parts = [], last = 0, mm;
    HOLE.lastIndex = 0;
    while ((mm = HOLE.exec(raw))) {
      if (mm.index > last) parts.push(decodeIt ? decode(raw.slice(last, mm.index)) : raw.slice(last, mm.index));
      parts.push({ path: mm[1] });
      last = HOLE.lastIndex;
    }
    if (last < raw.length) parts.push(decodeIt ? decode(raw.slice(last)) : raw.slice(last));
    return { parts: parts };
  }
  function lookup(scope, path) {
    if (path === 'true') return true;
    if (path === 'false') return false;
    if (path === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
    var keys = path.split('.');
    var cur = scope[keys[0]];
    for (var i = 1; i < keys.length; i++) {
      if (cur == null) return undefined;
      cur = cur[keys[i]];
    }
    return cur;
  }
  function str(v) { return v == null || v === false ? '' : String(v); }
  function evalValue(cv, scope) {
    if (cv === null || typeof cv !== 'object') return cv; // static string, or true for a present boolean attribute
    if (cv.whole !== undefined) return lookup(scope, cv.whole);
    var out = '';
    for (var i = 0; i < cv.parts.length; i++) {
      var p = cv.parts[i];
      out += typeof p === 'string' ? p : str(lookup(scope, p.path));
    }
    return out;
  }

  /* ---------------- template parser ---------------- */
  // A small tokenizer for well-formed template markup: every non-void element is closed and every
  // attribute value is quoted. It keeps attribute case (onClick, viewBox), which the browser's HTML
  // parser would fold to lower case.
  function parse(src) {
    var root = { tag: '#root', attrs: [], kids: [] };
    var stack = [root];
    var i = 0, n = src.length;
    function top() { return stack[stack.length - 1]; }
    function addText(t) {
      // like the canvas runtime: whitespace made only of line breaks is dropped, indentation is kept
      if (!t || /^[\r\n]+$/.test(t)) return;
      top().kids.push({ text: compileValue(t, true) });
    }
    while (i < n) {
      var lt = src.indexOf('<', i);
      if (lt < 0) { addText(src.slice(i)); break; }
      if (lt > i) addText(src.slice(i, lt));
      i = lt;
      if (src.startsWith('<!--', i)) {
        var endc = src.indexOf('-->', i + 4);
        i = endc < 0 ? n : endc + 3;
        continue;
      }
      if (src[i + 1] === '/') {
        var gt = src.indexOf('>', i);
        var name = src.slice(i + 2, gt < 0 ? n : gt).trim().toLowerCase();
        i = gt < 0 ? n : gt + 1;
        for (var k = stack.length - 1; k > 0; k--) {
          if (stack[k].tag.toLowerCase() === name) { stack.length = k; break; }
        }
        continue;
      }
      var tm = /^<([A-Za-z][A-Za-z0-9:-]*)/.exec(src.slice(i, i + 64));
      if (!tm) { addText('<'); i += 1; continue; }
      var tag = tm[1];
      i += tm[0].length;
      var attrs = [], selfClose = false;
      while (i < n) {
        while (i < n && /\s/.test(src[i])) i++;
        if (src[i] === '>') { i++; break; }
        if (src[i] === '/' && src[i + 1] === '>') { selfClose = true; i += 2; break; }
        var am = /^[^\s=\/>]+/.exec(src.slice(i, i + 128));
        if (!am) { i++; continue; }
        var aname = am[0];
        i += aname.length;
        while (i < n && /\s/.test(src[i])) i++;
        var aval = null;
        if (src[i] === '=') {
          i++;
          while (i < n && /\s/.test(src[i])) i++;
          var q = src[i];
          if (q === '"' || q === "'") {
            var endq = src.indexOf(q, i + 1);
            aval = src.slice(i + 1, endq < 0 ? n : endq);
            i = endq < 0 ? n : endq + 1;
          } else {
            var um = /^[^\s>]+/.exec(src.slice(i));
            aval = um ? um[0] : '';
            i += aval.length;
          }
        }
        attrs.push({ name: aname, raw: aval });
      }
      var node = { tag: tag, attrs: attrs, kids: [] };
      top().kids.push(node);
      var lower = tag.toLowerCase();
      if (RAW[lower]) {
        var close = src.toLowerCase().indexOf('</' + lower, i);
        var body = src.slice(i, close < 0 ? n : close);
        if (body) node.kids.push({ rawText: body });
        var gt2 = close < 0 ? -1 : src.indexOf('>', close);
        i = gt2 < 0 ? n : gt2 + 1;
        continue;
      }
      if (!selfClose && !VOID[lower]) stack.push(node);
    }
    prepare(root, false);
    return root;
  }

  function camel(name) {
    return name.replace(/[-:]([a-z])/g, function (_, c) { return c.toUpperCase(); });
  }
  function propName(name) {
    var lower = name.toLowerCase();
    if (NAME[lower]) return NAME[lower];
    if (lower.indexOf('aria-') === 0 || lower.indexOf('data-') === 0) return lower;
    if (/^on[A-Z]/.test(name)) return name;
    if (name.indexOf('-') > 0 || name.indexOf(':') > 0) return camel(name);
    return name;
  }

  // compile attributes once; drop whitespace text where React does not allow it
  function prepare(node, inSvg) {
    var lower = node.tag.toLowerCase();
    var svg = inSvg || lower === 'svg';
    if (node.attrs) {
      var typeAttr = '';
      node.attrs.forEach(function (a) { if (a.name.toLowerCase() === 'type' && a.raw) typeAttr = a.raw.toLowerCase(); });
      node.props = [];
      node.attrs.forEach(function (a) {
        var lname = a.name.toLowerCase();
        if (lname.indexOf('hint-') === 0) return;
        if (lower === 'sc-for' || lower === 'sc-if') {
          node[lname] = a.raw == null ? '' : compileValue(a.raw, true);
          return;
        }
        var p = propName(a.name);
        var cv = a.raw == null ? '' : compileValue(a.raw, true);
        var isStatic = typeof cv === 'string';
        if (isStatic && BOOL[p]) cv = true;
        if (isStatic && p === 'value' && (lower === 'textarea' || lower === 'select' || (lower === 'input' && TEXTLIKE_INPUT[typeAttr]))) p = 'defaultValue';
        if (isStatic && p === 'checked' && lower === 'input') p = 'defaultChecked';
        if (p === 'style' && isStatic) cv = { style: parseStyle(cv) };
        node.props.push({ name: p, cv: cv });
      });
    }
    var noWs = NO_WS[lower];
    node.kids = node.kids.filter(function (k) {
      if (k.text === undefined || !noWs) return true;
      return !(typeof k.text === 'string' && /^\s*$/.test(k.text));
    });
    node.kids.forEach(function (k) { if (k.tag) prepare(k, svg); });
  }

  /* ---------------- inline style strings ---------------- */
  function parseStyle(s) {
    var out = {};
    if (!s) return out;
    var decls = [], buf = '', depth = 0, quote = null;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (quote) { if (c === quote) quote = null; buf += c; continue; }
      if (c === '"' || c === "'") { quote = c; buf += c; continue; }
      if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      if (c === ';' && depth === 0) { decls.push(buf); buf = ''; continue; }
      buf += c;
    }
    decls.push(buf);
    decls.forEach(function (d) {
      var idx = d.indexOf(':');
      if (idx < 0) return;
      var prop = d.slice(0, idx).trim();
      var val = d.slice(idx + 1).trim();
      if (!prop) return;
      if (prop.indexOf('--') === 0) { out[prop] = val; return; }
      prop = prop.toLowerCase();
      if (prop.indexOf('-ms-') === 0) prop = 'ms-' + prop.slice(4);
      else if (prop[0] === '-') prop = prop.slice(1).replace(/^([a-z])/, function (m) { return m.toUpperCase(); });
      out[camel(prop)] = val;
    });
    return out;
  }

  /* ---------------- render ---------------- */
  function child(scope, extra) {
    var s = Object.create(scope);
    for (var k in extra) s[k] = extra[k];
    return s;
  }

  function renderKids(kids, scope) {
    var out = [];
    for (var i = 0; i < kids.length; i++) {
      var r = renderNode(kids[i], scope, i);
      if (r !== null && r !== undefined) out.push(r);
    }
    return out;
  }

  function renderNode(node, scope, key) {
    if (node.rawText !== undefined) return node.rawText;
    if (node.text !== undefined) {
      var v = evalValue(node.text, scope);
      if (v == null || typeof v === 'boolean') return null;
      if (typeof v === 'object') return React.isValidElement(v) ? React.cloneElement(v, { key: key }) : String(v);
      return String(v);
    }
    var lower = node.tag.toLowerCase();
    if (lower === 'sc-for') {
      var list = node.list === undefined ? [] : evalValue(node.list, scope);
      var as = typeof node.as === 'string' && node.as ? node.as : 'item';
      if (!list || typeof list.length !== 'number') return null;
      var items = [];
      for (var i = 0; i < list.length; i++) {
        var extra = { $index: i };
        extra[as] = list[i];
        items.push(h(React.Fragment, { key: i }, renderKids(node.kids, child(scope, extra))));
      }
      return h(React.Fragment, { key: key }, items);
    }
    if (lower === 'sc-if') {
      var cond = node.value === undefined ? false : evalValue(node.value, scope);
      if (!cond) return null;
      return h(React.Fragment, { key: key }, renderKids(node.kids, scope));
    }
    var props = { key: key };
    for (var j = 0; j < node.props.length; j++) {
      var p = node.props[j];
      var val;
      if (p.cv && p.cv.style) val = p.cv.style;
      else {
        val = evalValue(p.cv, scope);
        if (p.name === 'style' && typeof val === 'string') val = parseStyle(val);
      }
      if (val === undefined || val === null) continue;
      props[p.name] = val;
    }
    var kids = renderKids(node.kids, scope);
    if (lower === 'textarea') {
      // React takes a textarea's text as its value, never as children
      if (props.value === undefined && props.defaultValue === undefined && kids.length) props.defaultValue = kids.join('');
      return h(node.tag, props);
    }
    if (VOID[lower]) return h(node.tag, props);
    return kids.length ? h.apply(null, [node.tag, props].concat(kids)) : h(node.tag, props);
  }

  /* ---------------- boot ---------------- */
  function keepDocumentLangInSync(container) {
    var html = document.documentElement;
    function sync() {
      var el = container.querySelector('[lang]');
      if (!el) return;
      var lang = el.getAttribute('lang');
      var dir = el.getAttribute('dir');
      if (lang && html.getAttribute('lang') !== lang) html.setAttribute('lang', lang);
      if (dir && html.getAttribute('dir') !== dir) html.setAttribute('dir', dir);
      // tab title follows the language when the page provides both (preview pages built by build.py)
      var t = document.querySelector('meta[name="dc-title-' + (/^ar\b/.test(lang || '') ? 'ar' : 'en') + '"]');
      if (t && t.content && document.title !== t.content) document.title = t.content;
    }
    sync();
    try {
      new MutationObserver(sync).observe(container, { subtree: true, attributes: true, attributeFilter: ['lang', 'dir'], childList: true });
    } catch (e) {}
  }

  function boot(defineComponent) {
    var tplEl = document.getElementById('dc-template');
    var propsEl = document.getElementById('dc-props');
    var container = document.getElementById('dc-root');
    var tree = parse(tplEl.textContent);
    var props = {};
    try { props = propsEl ? JSON.parse(propsEl.textContent) : {}; } catch (e) { props = {}; }

    class DCLogic extends React.Component {
      renderVals() { return {}; }
      render() {
        var vals = this.renderVals() || {};
        return h(React.Fragment, null, renderKids(tree.kids, vals));
      }
    }
    var Component = defineComponent(DCLogic);
    ReactDOM.createRoot(container).render(h(Component, props));
    keepDocumentLangInSync(container);
  }

  window.DCLite = { boot: boot, parse: parse, parseStyle: parseStyle };
})();
