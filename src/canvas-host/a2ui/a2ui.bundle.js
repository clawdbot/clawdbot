var __defProp$1 = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp$1(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp$1(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
/**
* @license
* Copyright 2019 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
const t$6 = globalThis, e$13 = t$6.ShadowRoot && (void 0 === t$6.ShadyCSS || t$6.ShadyCSS.nativeShadow) && "adoptedStyleSheets" in Document.prototype && "replace" in CSSStyleSheet.prototype, s$8 = Symbol(), o$14 = /* @__PURE__ */ new WeakMap();
var n$12 = class {
	constructor(t, e, o) {
		if (this._$cssResult$ = !0, o !== s$8) throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");
		this.cssText = t, this.t = e;
	}
	get styleSheet() {
		let t = this.o;
		const s = this.t;
		if (e$13 && void 0 === t) {
			const e = void 0 !== s && 1 === s.length;
			e && (t = o$14.get(s)), void 0 === t && ((this.o = t = new CSSStyleSheet()).replaceSync(this.cssText), e && o$14.set(s, t));
		}
		return t;
	}
	toString() {
		return this.cssText;
	}
};
const r$11 = (t) => new n$12("string" == typeof t ? t : t + "", void 0, s$8), i$9 = (t, ...e) => {
	return new n$12(1 === t.length ? t[0] : e.reduce((e, s, o) => e + ((t) => {
		if (!0 === t._$cssResult$) return t.cssText;
		if ("number" == typeof t) return t;
		throw Error("Value passed to 'css' function must be a 'css' function result: " + t + ". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.");
	})(s) + t[o + 1], t[0]), t, s$8);
}, S$1 = (s, o) => {
	if (e$13) s.adoptedStyleSheets = o.map((t) => t instanceof CSSStyleSheet ? t : t.styleSheet);
	else for (const e of o) {
		const o = document.createElement("style"), n = t$6.litNonce;
		void 0 !== n && o.setAttribute("nonce", n), o.textContent = e.cssText, s.appendChild(o);
	}
}, c$6 = e$13 ? (t) => t : (t) => t instanceof CSSStyleSheet ? ((t) => {
	let e = "";
	for (const s of t.cssRules) e += s.cssText;
	return r$11(e);
})(t) : t;
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ const { is: i$8, defineProperty: e$12, getOwnPropertyDescriptor: h$6, getOwnPropertyNames: r$10, getOwnPropertySymbols: o$13, getPrototypeOf: n$11 } = Object, a$1 = globalThis, c$5 = a$1.trustedTypes, l$4 = c$5 ? c$5.emptyScript : "", p$2 = a$1.reactiveElementPolyfillSupport, d$2 = (t, s) => t, u$3 = {
	toAttribute(t, s) {
		switch (s) {
			case Boolean:
				t = t ? l$4 : null;
				break;
			case Object:
			case Array: t = null == t ? t : JSON.stringify(t);
		}
		return t;
	},
	fromAttribute(t, s) {
		let i = t;
		switch (s) {
			case Boolean:
				i = null !== t;
				break;
			case Number:
				i = null === t ? null : Number(t);
				break;
			case Object:
			case Array: try {
				i = JSON.parse(t);
			} catch (t) {
				i = null;
			}
		}
		return i;
	}
}, f$3 = (t, s) => !i$8(t, s), b$1 = {
	attribute: !0,
	type: String,
	converter: u$3,
	reflect: !1,
	useDefault: !1,
	hasChanged: f$3
};
Symbol.metadata ??= Symbol("metadata"), a$1.litPropertyMetadata ??= /* @__PURE__ */ new WeakMap();
var y$1 = class extends HTMLElement {
	static addInitializer(t) {
		this._$Ei(), (this.l ??= []).push(t);
	}
	static get observedAttributes() {
		return this.finalize(), this._$Eh && [...this._$Eh.keys()];
	}
	static createProperty(t, s = b$1) {
		if (s.state && (s.attribute = !1), this._$Ei(), this.prototype.hasOwnProperty(t) && ((s = Object.create(s)).wrapped = !0), this.elementProperties.set(t, s), !s.noAccessor) {
			const i = Symbol(), h = this.getPropertyDescriptor(t, i, s);
			void 0 !== h && e$12(this.prototype, t, h);
		}
	}
	static getPropertyDescriptor(t, s, i) {
		const { get: e, set: r } = h$6(this.prototype, t) ?? {
			get() {
				return this[s];
			},
			set(t) {
				this[s] = t;
			}
		};
		return {
			get: e,
			set(s) {
				const h = e?.call(this);
				r?.call(this, s), this.requestUpdate(t, h, i);
			},
			configurable: !0,
			enumerable: !0
		};
	}
	static getPropertyOptions(t) {
		return this.elementProperties.get(t) ?? b$1;
	}
	static _$Ei() {
		if (this.hasOwnProperty(d$2("elementProperties"))) return;
		const t = n$11(this);
		t.finalize(), void 0 !== t.l && (this.l = [...t.l]), this.elementProperties = new Map(t.elementProperties);
	}
	static finalize() {
		if (this.hasOwnProperty(d$2("finalized"))) return;
		if (this.finalized = !0, this._$Ei(), this.hasOwnProperty(d$2("properties"))) {
			const t = this.properties, s = [...r$10(t), ...o$13(t)];
			for (const i of s) this.createProperty(i, t[i]);
		}
		const t = this[Symbol.metadata];
		if (null !== t) {
			const s = litPropertyMetadata.get(t);
			if (void 0 !== s) for (const [t, i] of s) this.elementProperties.set(t, i);
		}
		this._$Eh = /* @__PURE__ */ new Map();
		for (const [t, s] of this.elementProperties) {
			const i = this._$Eu(t, s);
			void 0 !== i && this._$Eh.set(i, t);
		}
		this.elementStyles = this.finalizeStyles(this.styles);
	}
	static finalizeStyles(s) {
		const i = [];
		if (Array.isArray(s)) {
			const e = new Set(s.flat(Infinity).reverse());
			for (const s of e) i.unshift(c$6(s));
		} else void 0 !== s && i.push(c$6(s));
		return i;
	}
	static _$Eu(t, s) {
		const i = s.attribute;
		return !1 === i ? void 0 : "string" == typeof i ? i : "string" == typeof t ? t.toLowerCase() : void 0;
	}
	constructor() {
		super(), this._$Ep = void 0, this.isUpdatePending = !1, this.hasUpdated = !1, this._$Em = null, this._$Ev();
	}
	_$Ev() {
		this._$ES = new Promise((t) => this.enableUpdating = t), this._$AL = /* @__PURE__ */ new Map(), this._$E_(), this.requestUpdate(), this.constructor.l?.forEach((t) => t(this));
	}
	addController(t) {
		(this._$EO ??= /* @__PURE__ */ new Set()).add(t), void 0 !== this.renderRoot && this.isConnected && t.hostConnected?.();
	}
	removeController(t) {
		this._$EO?.delete(t);
	}
	_$E_() {
		const t = /* @__PURE__ */ new Map(), s = this.constructor.elementProperties;
		for (const i of s.keys()) this.hasOwnProperty(i) && (t.set(i, this[i]), delete this[i]);
		t.size > 0 && (this._$Ep = t);
	}
	createRenderRoot() {
		const t = this.shadowRoot ?? this.attachShadow(this.constructor.shadowRootOptions);
		return S$1(t, this.constructor.elementStyles), t;
	}
	connectedCallback() {
		this.renderRoot ??= this.createRenderRoot(), this.enableUpdating(!0), this._$EO?.forEach((t) => t.hostConnected?.());
	}
	enableUpdating(t) {}
	disconnectedCallback() {
		this._$EO?.forEach((t) => t.hostDisconnected?.());
	}
	attributeChangedCallback(t, s, i) {
		this._$AK(t, i);
	}
	_$ET(t, s) {
		const i = this.constructor.elementProperties.get(t), e = this.constructor._$Eu(t, i);
		if (void 0 !== e && !0 === i.reflect) {
			const h = (void 0 !== i.converter?.toAttribute ? i.converter : u$3).toAttribute(s, i.type);
			this._$Em = t, null == h ? this.removeAttribute(e) : this.setAttribute(e, h), this._$Em = null;
		}
	}
	_$AK(t, s) {
		const i = this.constructor, e = i._$Eh.get(t);
		if (void 0 !== e && this._$Em !== e) {
			const t = i.getPropertyOptions(e), h = "function" == typeof t.converter ? { fromAttribute: t.converter } : void 0 !== t.converter?.fromAttribute ? t.converter : u$3;
			this._$Em = e;
			const r = h.fromAttribute(s, t.type);
			this[e] = r ?? this._$Ej?.get(e) ?? r, this._$Em = null;
		}
	}
	requestUpdate(t, s, i, e = !1, h) {
		if (void 0 !== t) {
			const r = this.constructor;
			if (!1 === e && (h = this[t]), i ??= r.getPropertyOptions(t), !((i.hasChanged ?? f$3)(h, s) || i.useDefault && i.reflect && h === this._$Ej?.get(t) && !this.hasAttribute(r._$Eu(t, i)))) return;
			this.C(t, s, i);
		}
		!1 === this.isUpdatePending && (this._$ES = this._$EP());
	}
	C(t, s, { useDefault: i, reflect: e, wrapped: h }, r) {
		i && !(this._$Ej ??= /* @__PURE__ */ new Map()).has(t) && (this._$Ej.set(t, r ?? s ?? this[t]), !0 !== h || void 0 !== r) || (this._$AL.has(t) || (this.hasUpdated || i || (s = void 0), this._$AL.set(t, s)), !0 === e && this._$Em !== t && (this._$Eq ??= /* @__PURE__ */ new Set()).add(t));
	}
	async _$EP() {
		this.isUpdatePending = !0;
		try {
			await this._$ES;
		} catch (t) {
			Promise.reject(t);
		}
		const t = this.scheduleUpdate();
		return null != t && await t, !this.isUpdatePending;
	}
	scheduleUpdate() {
		return this.performUpdate();
	}
	performUpdate() {
		if (!this.isUpdatePending) return;
		if (!this.hasUpdated) {
			if (this.renderRoot ??= this.createRenderRoot(), this._$Ep) {
				for (const [t, s] of this._$Ep) this[t] = s;
				this._$Ep = void 0;
			}
			const t = this.constructor.elementProperties;
			if (t.size > 0) for (const [s, i] of t) {
				const { wrapped: t } = i, e = this[s];
				!0 !== t || this._$AL.has(s) || void 0 === e || this.C(s, void 0, i, e);
			}
		}
		let t = !1;
		const s = this._$AL;
		try {
			t = this.shouldUpdate(s), t ? (this.willUpdate(s), this._$EO?.forEach((t) => t.hostUpdate?.()), this.update(s)) : this._$EM();
		} catch (s) {
			throw t = !1, this._$EM(), s;
		}
		t && this._$AE(s);
	}
	willUpdate(t) {}
	_$AE(t) {
		this._$EO?.forEach((t) => t.hostUpdated?.()), this.hasUpdated || (this.hasUpdated = !0, this.firstUpdated(t)), this.updated(t);
	}
	_$EM() {
		this._$AL = /* @__PURE__ */ new Map(), this.isUpdatePending = !1;
	}
	get updateComplete() {
		return this.getUpdateComplete();
	}
	getUpdateComplete() {
		return this._$ES;
	}
	shouldUpdate(t) {
		return !0;
	}
	update(t) {
		this._$Eq &&= this._$Eq.forEach((t) => this._$ET(t, this[t])), this._$EM();
	}
	updated(t) {}
	firstUpdated(t) {}
};
y$1.elementStyles = [], y$1.shadowRootOptions = { mode: "open" }, y$1[d$2("elementProperties")] = /* @__PURE__ */ new Map(), y$1[d$2("finalized")] = /* @__PURE__ */ new Map(), p$2?.({ ReactiveElement: y$1 }), (a$1.reactiveElementVersions ??= []).push("2.1.2");
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
const t$5 = globalThis, i$7 = (t) => t, s$7 = t$5.trustedTypes, e$11 = s$7 ? s$7.createPolicy("lit-html", { createHTML: (t) => t }) : void 0, h$5 = "$lit$", o$12 = `lit$${Math.random().toFixed(9).slice(2)}$`, n$10 = "?" + o$12, r$9 = `<${n$10}>`, l$3 = document, c$4 = () => l$3.createComment(""), a = (t) => null === t || "object" != typeof t && "function" != typeof t, u$2 = Array.isArray, d$1 = (t) => u$2(t) || "function" == typeof t?.[Symbol.iterator], f$2 = "[ 	\n\f\r]", v$1 = /<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g, _ = /-->/g, m$2 = />/g, p$1 = RegExp(`>|${f$2}(?:([^\\s"'>=/]+)(${f$2}*=${f$2}*(?:[^ \t\n\f\r"'\`<>=]|("|')|))|$)`, "g"), g = /'/g, $ = /"/g, y = /^(?:script|style|textarea|title)$/i, x = (t) => (i, ...s) => ({
	_$litType$: t,
	strings: i,
	values: s
}), b = x(1), w = x(2);
x(3);
const E = Symbol.for("lit-noChange"), A = Symbol.for("lit-nothing"), C = /* @__PURE__ */ new WeakMap(), P = l$3.createTreeWalker(l$3, 129);
function V(t, i) {
	if (!u$2(t) || !t.hasOwnProperty("raw")) throw Error("invalid template strings array");
	return void 0 !== e$11 ? e$11.createHTML(i) : i;
}
const N = (t, i) => {
	const s = t.length - 1, e = [];
	let n, l = 2 === i ? "<svg>" : 3 === i ? "<math>" : "", c = v$1;
	for (let i = 0; i < s; i++) {
		const s = t[i];
		let a, u, d = -1, f = 0;
		for (; f < s.length && (c.lastIndex = f, u = c.exec(s), null !== u);) f = c.lastIndex, c === v$1 ? "!--" === u[1] ? c = _ : void 0 !== u[1] ? c = m$2 : void 0 !== u[2] ? (y.test(u[2]) && (n = RegExp("</" + u[2], "g")), c = p$1) : void 0 !== u[3] && (c = p$1) : c === p$1 ? ">" === u[0] ? (c = n ?? v$1, d = -1) : void 0 === u[1] ? d = -2 : (d = c.lastIndex - u[2].length, a = u[1], c = void 0 === u[3] ? p$1 : "\"" === u[3] ? $ : g) : c === $ || c === g ? c = p$1 : c === _ || c === m$2 ? c = v$1 : (c = p$1, n = void 0);
		const x = c === p$1 && t[i + 1].startsWith("/>") ? " " : "";
		l += c === v$1 ? s + r$9 : d >= 0 ? (e.push(a), s.slice(0, d) + h$5 + s.slice(d) + o$12 + x) : s + o$12 + (-2 === d ? i : x);
	}
	return [V(t, l + (t[s] || "<?>") + (2 === i ? "</svg>" : 3 === i ? "</math>" : "")), e];
};
var S = class S {
	constructor({ strings: t, _$litType$: i }, e) {
		let r;
		this.parts = [];
		let l = 0, a = 0;
		const u = t.length - 1, d = this.parts, [f, v] = N(t, i);
		if (this.el = S.createElement(f, e), P.currentNode = this.el.content, 2 === i || 3 === i) {
			const t = this.el.content.firstChild;
			t.replaceWith(...t.childNodes);
		}
		for (; null !== (r = P.nextNode()) && d.length < u;) {
			if (1 === r.nodeType) {
				if (r.hasAttributes()) for (const t of r.getAttributeNames()) if (t.endsWith(h$5)) {
					const i = v[a++], s = r.getAttribute(t).split(o$12), e = /([.?@])?(.*)/.exec(i);
					d.push({
						type: 1,
						index: l,
						name: e[2],
						strings: s,
						ctor: "." === e[1] ? I : "?" === e[1] ? L : "@" === e[1] ? z : H
					}), r.removeAttribute(t);
				} else t.startsWith(o$12) && (d.push({
					type: 6,
					index: l
				}), r.removeAttribute(t));
				if (y.test(r.tagName)) {
					const t = r.textContent.split(o$12), i = t.length - 1;
					if (i > 0) {
						r.textContent = s$7 ? s$7.emptyScript : "";
						for (let s = 0; s < i; s++) r.append(t[s], c$4()), P.nextNode(), d.push({
							type: 2,
							index: ++l
						});
						r.append(t[i], c$4());
					}
				}
			} else if (8 === r.nodeType) if (r.data === n$10) d.push({
				type: 2,
				index: l
			});
			else {
				let t = -1;
				for (; -1 !== (t = r.data.indexOf(o$12, t + 1));) d.push({
					type: 7,
					index: l
				}), t += o$12.length - 1;
			}
			l++;
		}
	}
	static createElement(t, i) {
		const s = l$3.createElement("template");
		return s.innerHTML = t, s;
	}
};
function M$1(t, i, s = t, e) {
	if (i === E) return i;
	let h = void 0 !== e ? s._$Co?.[e] : s._$Cl;
	const o = a(i) ? void 0 : i._$litDirective$;
	return h?.constructor !== o && (h?._$AO?.(!1), void 0 === o ? h = void 0 : (h = new o(t), h._$AT(t, s, e)), void 0 !== e ? (s._$Co ??= [])[e] = h : s._$Cl = h), void 0 !== h && (i = M$1(t, h._$AS(t, i.values), h, e)), i;
}
var R = class {
	constructor(t, i) {
		this._$AV = [], this._$AN = void 0, this._$AD = t, this._$AM = i;
	}
	get parentNode() {
		return this._$AM.parentNode;
	}
	get _$AU() {
		return this._$AM._$AU;
	}
	u(t) {
		const { el: { content: i }, parts: s } = this._$AD, e = (t?.creationScope ?? l$3).importNode(i, !0);
		P.currentNode = e;
		let h = P.nextNode(), o = 0, n = 0, r = s[0];
		for (; void 0 !== r;) {
			if (o === r.index) {
				let i;
				2 === r.type ? i = new k(h, h.nextSibling, this, t) : 1 === r.type ? i = new r.ctor(h, r.name, r.strings, this, t) : 6 === r.type && (i = new Z(h, this, t)), this._$AV.push(i), r = s[++n];
			}
			o !== r?.index && (h = P.nextNode(), o++);
		}
		return P.currentNode = l$3, e;
	}
	p(t) {
		let i = 0;
		for (const s of this._$AV) void 0 !== s && (void 0 !== s.strings ? (s._$AI(t, s, i), i += s.strings.length - 2) : s._$AI(t[i])), i++;
	}
};
var k = class k {
	get _$AU() {
		return this._$AM?._$AU ?? this._$Cv;
	}
	constructor(t, i, s, e) {
		this.type = 2, this._$AH = A, this._$AN = void 0, this._$AA = t, this._$AB = i, this._$AM = s, this.options = e, this._$Cv = e?.isConnected ?? !0;
	}
	get parentNode() {
		let t = this._$AA.parentNode;
		const i = this._$AM;
		return void 0 !== i && 11 === t?.nodeType && (t = i.parentNode), t;
	}
	get startNode() {
		return this._$AA;
	}
	get endNode() {
		return this._$AB;
	}
	_$AI(t, i = this) {
		t = M$1(this, t, i), a(t) ? t === A || null == t || "" === t ? (this._$AH !== A && this._$AR(), this._$AH = A) : t !== this._$AH && t !== E && this._(t) : void 0 !== t._$litType$ ? this.$(t) : void 0 !== t.nodeType ? this.T(t) : d$1(t) ? this.k(t) : this._(t);
	}
	O(t) {
		return this._$AA.parentNode.insertBefore(t, this._$AB);
	}
	T(t) {
		this._$AH !== t && (this._$AR(), this._$AH = this.O(t));
	}
	_(t) {
		this._$AH !== A && a(this._$AH) ? this._$AA.nextSibling.data = t : this.T(l$3.createTextNode(t)), this._$AH = t;
	}
	$(t) {
		const { values: i, _$litType$: s } = t, e = "number" == typeof s ? this._$AC(t) : (void 0 === s.el && (s.el = S.createElement(V(s.h, s.h[0]), this.options)), s);
		if (this._$AH?._$AD === e) this._$AH.p(i);
		else {
			const t = new R(e, this), s = t.u(this.options);
			t.p(i), this.T(s), this._$AH = t;
		}
	}
	_$AC(t) {
		let i = C.get(t.strings);
		return void 0 === i && C.set(t.strings, i = new S(t)), i;
	}
	k(t) {
		u$2(this._$AH) || (this._$AH = [], this._$AR());
		const i = this._$AH;
		let s, e = 0;
		for (const h of t) e === i.length ? i.push(s = new k(this.O(c$4()), this.O(c$4()), this, this.options)) : s = i[e], s._$AI(h), e++;
		e < i.length && (this._$AR(s && s._$AB.nextSibling, e), i.length = e);
	}
	_$AR(t = this._$AA.nextSibling, s) {
		for (this._$AP?.(!1, !0, s); t !== this._$AB;) {
			const s = i$7(t).nextSibling;
			i$7(t).remove(), t = s;
		}
	}
	setConnected(t) {
		void 0 === this._$AM && (this._$Cv = t, this._$AP?.(t));
	}
};
var H = class {
	get tagName() {
		return this.element.tagName;
	}
	get _$AU() {
		return this._$AM._$AU;
	}
	constructor(t, i, s, e, h) {
		this.type = 1, this._$AH = A, this._$AN = void 0, this.element = t, this.name = i, this._$AM = e, this.options = h, s.length > 2 || "" !== s[0] || "" !== s[1] ? (this._$AH = Array(s.length - 1).fill(/* @__PURE__ */ new String()), this.strings = s) : this._$AH = A;
	}
	_$AI(t, i = this, s, e) {
		const h = this.strings;
		let o = !1;
		if (void 0 === h) t = M$1(this, t, i, 0), o = !a(t) || t !== this._$AH && t !== E, o && (this._$AH = t);
		else {
			const e = t;
			let n, r;
			for (t = h[0], n = 0; n < h.length - 1; n++) r = M$1(this, e[s + n], i, n), r === E && (r = this._$AH[n]), o ||= !a(r) || r !== this._$AH[n], r === A ? t = A : t !== A && (t += (r ?? "") + h[n + 1]), this._$AH[n] = r;
		}
		o && !e && this.j(t);
	}
	j(t) {
		t === A ? this.element.removeAttribute(this.name) : this.element.setAttribute(this.name, t ?? "");
	}
};
var I = class extends H {
	constructor() {
		super(...arguments), this.type = 3;
	}
	j(t) {
		this.element[this.name] = t === A ? void 0 : t;
	}
};
var L = class extends H {
	constructor() {
		super(...arguments), this.type = 4;
	}
	j(t) {
		this.element.toggleAttribute(this.name, !!t && t !== A);
	}
};
var z = class extends H {
	constructor(t, i, s, e, h) {
		super(t, i, s, e, h), this.type = 5;
	}
	_$AI(t, i = this) {
		if ((t = M$1(this, t, i, 0) ?? A) === E) return;
		const s = this._$AH, e = t === A && s !== A || t.capture !== s.capture || t.once !== s.once || t.passive !== s.passive, h = t !== A && (s === A || e);
		e && this.element.removeEventListener(this.name, this, s), h && this.element.addEventListener(this.name, this, t), this._$AH = t;
	}
	handleEvent(t) {
		"function" == typeof this._$AH ? this._$AH.call(this.options?.host ?? this.element, t) : this._$AH.handleEvent(t);
	}
};
var Z = class {
	constructor(t, i, s) {
		this.element = t, this.type = 6, this._$AN = void 0, this._$AM = i, this.options = s;
	}
	get _$AU() {
		return this._$AM._$AU;
	}
	_$AI(t) {
		M$1(this, t);
	}
};
const j$1 = {
	M: h$5,
	P: o$12,
	A: n$10,
	C: 1,
	L: N,
	R,
	D: d$1,
	V: M$1,
	I: k,
	H,
	N: L,
	U: z,
	B: I,
	F: Z
}, B = t$5.litHtmlPolyfillSupport;
B?.(S, k), (t$5.litHtmlVersions ??= []).push("3.3.2");
const D = (t, i, s) => {
	const e = s?.renderBefore ?? i;
	let h = e._$litPart$;
	if (void 0 === h) {
		const t = s?.renderBefore ?? null;
		e._$litPart$ = h = new k(i.insertBefore(c$4(), t), t, void 0, s ?? {});
	}
	return h._$AI(t), h;
};
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ const s$6 = globalThis;
var i$6 = class extends y$1 {
	constructor() {
		super(...arguments), this.renderOptions = { host: this }, this._$Do = void 0;
	}
	createRenderRoot() {
		const t = super.createRenderRoot();
		return this.renderOptions.renderBefore ??= t.firstChild, t;
	}
	update(t) {
		const r = this.render();
		this.hasUpdated || (this.renderOptions.isConnected = this.isConnected), super.update(t), this._$Do = D(r, this.renderRoot, this.renderOptions);
	}
	connectedCallback() {
		super.connectedCallback(), this._$Do?.setConnected(!0);
	}
	disconnectedCallback() {
		super.disconnectedCallback(), this._$Do?.setConnected(!1);
	}
	render() {
		return E;
	}
};
i$6._$litElement$ = !0, i$6["finalized"] = !0, s$6.litElementHydrateSupport?.({ LitElement: i$6 });
const o$11 = s$6.litElementPolyfillSupport;
o$11?.({ LitElement: i$6 });
(s$6.litElementVersions ??= []).push("4.2.2");
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
const t$4 = {
	ATTRIBUTE: 1,
	CHILD: 2,
	PROPERTY: 3,
	BOOLEAN_ATTRIBUTE: 4,
	EVENT: 5,
	ELEMENT: 6
}, e$10 = (t) => (...e) => ({
	_$litDirective$: t,
	values: e
});
var i$5 = class {
	constructor(t) {}
	get _$AU() {
		return this._$AM._$AU;
	}
	_$AT(t, e, i) {
		this._$Ct = t, this._$AM = e, this._$Ci = i;
	}
	_$AS(t, e) {
		return this.update(t, e);
	}
	update(t, e) {
		return this.render(...e);
	}
};
/**
* @license
* Copyright 2020 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ const { I: t$3 } = j$1, i$4 = (o) => o, r$8 = (o) => void 0 === o.strings, s$5 = () => document.createComment(""), v = (o, n, e) => {
	const l = o._$AA.parentNode, d = void 0 === n ? o._$AB : n._$AA;
	if (void 0 === e) e = new t$3(l.insertBefore(s$5(), d), l.insertBefore(s$5(), d), o, o.options);
	else {
		const t = e._$AB.nextSibling, n = e._$AM, c = n !== o;
		if (c) {
			let t;
			e._$AQ?.(o), e._$AM = o, void 0 !== e._$AP && (t = o._$AU) !== n._$AU && e._$AP(t);
		}
		if (t !== d || c) {
			let o = e._$AA;
			for (; o !== t;) {
				const t = i$4(o).nextSibling;
				i$4(l).insertBefore(o, d), o = t;
			}
		}
	}
	return e;
}, u$1 = (o, t, i = o) => (o._$AI(t, i), o), m$1 = {}, p = (o, t = m$1) => o._$AH = t, M = (o) => o._$AH, h$4 = (o) => {
	o._$AR(), o._$AA.remove();
};
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
const u = (e, s, t) => {
	const r = /* @__PURE__ */ new Map();
	for (let l = s; l <= t; l++) r.set(e[l], l);
	return r;
}, c$2 = e$10(class extends i$5 {
	constructor(e) {
		if (super(e), e.type !== t$4.CHILD) throw Error("repeat() can only be used in text expressions");
	}
	dt(e, s, t) {
		let r;
		void 0 === t ? t = s : void 0 !== s && (r = s);
		const l = [], o = [];
		let i = 0;
		for (const s of e) l[i] = r ? r(s, i) : i, o[i] = t(s, i), i++;
		return {
			values: o,
			keys: l
		};
	}
	render(e, s, t) {
		return this.dt(e, s, t).values;
	}
	update(s, [t, r, c]) {
		const d = M(s), { values: p$3, keys: a } = this.dt(t, r, c);
		if (!Array.isArray(d)) return this.ut = a, p$3;
		const h = this.ut ??= [], v$2 = [];
		let m, y, x = 0, j = d.length - 1, k = 0, w = p$3.length - 1;
		for (; x <= j && k <= w;) if (null === d[x]) x++;
		else if (null === d[j]) j--;
		else if (h[x] === a[k]) v$2[k] = u$1(d[x], p$3[k]), x++, k++;
		else if (h[j] === a[w]) v$2[w] = u$1(d[j], p$3[w]), j--, w--;
		else if (h[x] === a[w]) v$2[w] = u$1(d[x], p$3[w]), v(s, v$2[w + 1], d[x]), x++, w--;
		else if (h[j] === a[k]) v$2[k] = u$1(d[j], p$3[k]), v(s, d[x], d[j]), j--, k++;
		else if (void 0 === m && (m = u(a, k, w), y = u(h, x, j)), m.has(h[x])) if (m.has(h[j])) {
			const e = y.get(a[k]), t = void 0 !== e ? d[e] : null;
			if (null === t) {
				const e = v(s, d[x]);
				u$1(e, p$3[k]), v$2[k] = e;
			} else v$2[k] = u$1(t, p$3[k]), v(s, d[x], t), d[e] = null;
			k++;
		} else h$4(d[j]), j--;
		else h$4(d[x]), x++;
		for (; k <= w;) {
			const e = v(s, v$2[w + 1]);
			u$1(e, p$3[k]), v$2[k++] = e;
		}
		for (; x <= j;) {
			const e = d[x++];
			null !== e && h$4(e);
		}
		return this.ut = a, p(s, v$2), E;
	}
});
/**
* @license
* Copyright 2021 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
var s$4 = class extends Event {
	constructor(s, t, e, o) {
		super("context-request", {
			bubbles: !0,
			composed: !0
		}), this.context = s, this.contextTarget = t, this.callback = e, this.subscribe = o ?? !1;
	}
};
/**
* @license
* Copyright 2021 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
function n$7(n) {
	return n;
}
/**
* @license
* Copyright 2021 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ var s$3 = class {
	constructor(t, s, i, h) {
		if (this.subscribe = !1, this.provided = !1, this.value = void 0, this.t = (t, s) => {
			this.unsubscribe && (this.unsubscribe !== s && (this.provided = !1, this.unsubscribe()), this.subscribe || this.unsubscribe()), this.value = t, this.host.requestUpdate(), this.provided && !this.subscribe || (this.provided = !0, this.callback && this.callback(t, s)), this.unsubscribe = s;
		}, this.host = t, void 0 !== s.context) {
			const t = s;
			this.context = t.context, this.callback = t.callback, this.subscribe = t.subscribe ?? !1;
		} else this.context = s, this.callback = i, this.subscribe = h ?? !1;
		this.host.addController(this);
	}
	hostConnected() {
		this.dispatchRequest();
	}
	hostDisconnected() {
		this.unsubscribe && (this.unsubscribe(), this.unsubscribe = void 0);
	}
	dispatchRequest() {
		this.host.dispatchEvent(new s$4(this.context, this.host, this.t, this.subscribe));
	}
};
/**
* @license
* Copyright 2021 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
var s$2 = class {
	get value() {
		return this.o;
	}
	set value(s) {
		this.setValue(s);
	}
	setValue(s, t = !1) {
		const i = t || !Object.is(s, this.o);
		this.o = s, i && this.updateObservers();
	}
	constructor(s) {
		this.subscriptions = /* @__PURE__ */ new Map(), this.updateObservers = () => {
			for (const [s, { disposer: t }] of this.subscriptions) s(this.o, t);
		}, void 0 !== s && (this.value = s);
	}
	addCallback(s, t, i) {
		if (!i) return void s(this.value);
		this.subscriptions.has(s) || this.subscriptions.set(s, {
			disposer: () => {
				this.subscriptions.delete(s);
			},
			consumerHost: t
		});
		const { disposer: h } = this.subscriptions.get(s);
		s(this.value, h);
	}
	clearCallbacks() {
		this.subscriptions.clear();
	}
};
/**
* @license
* Copyright 2021 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ var e$8 = class extends Event {
	constructor(t, s) {
		super("context-provider", {
			bubbles: !0,
			composed: !0
		}), this.context = t, this.contextTarget = s;
	}
};
var i$3 = class extends s$2 {
	constructor(s, e, i) {
		super(void 0 !== e.context ? e.initialValue : i), this.onContextRequest = (t) => {
			if (t.context !== this.context) return;
			const s = t.contextTarget ?? t.composedPath()[0];
			s !== this.host && (t.stopPropagation(), this.addCallback(t.callback, s, t.subscribe));
		}, this.onProviderRequest = (s) => {
			if (s.context !== this.context) return;
			if ((s.contextTarget ?? s.composedPath()[0]) === this.host) return;
			const e = /* @__PURE__ */ new Set();
			for (const [s, { consumerHost: i }] of this.subscriptions) e.has(s) || (e.add(s), i.dispatchEvent(new s$4(this.context, i, s, !0)));
			s.stopPropagation();
		}, this.host = s, void 0 !== e.context ? this.context = e.context : this.context = e, this.attachListeners(), this.host.addController?.(this);
	}
	attachListeners() {
		this.host.addEventListener("context-request", this.onContextRequest), this.host.addEventListener("context-provider", this.onProviderRequest);
	}
	hostConnected() {
		this.host.dispatchEvent(new e$8(this.context, this.host));
	}
};
/**
* @license
* Copyright 2022 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ function c$1({ context: c, subscribe: e }) {
	return (o, n) => {
		"object" == typeof n ? n.addInitializer((function() {
			new s$3(this, {
				context: c,
				callback: (t) => {
					o.set.call(this, t);
				},
				subscribe: e
			});
		})) : o.constructor.addInitializer(((o) => {
			new s$3(o, {
				context: c,
				callback: (t) => {
					o[n] = t;
				},
				subscribe: e
			});
		}));
	};
}
const eventInit = {
	bubbles: true,
	cancelable: true,
	composed: true
};
var StateEvent = class StateEvent extends CustomEvent {
	static {
		this.eventName = "a2uiaction";
	}
	constructor(payload) {
		super(StateEvent.eventName, {
			detail: payload,
			...eventInit
		});
		this.payload = payload;
	}
};
const opacityBehavior = `
  &:not([disabled]) {
    cursor: pointer;
    opacity: var(--opacity, 0);
    transition: opacity var(--speed, 0.2s) cubic-bezier(0, 0, 0.3, 1);

    &:hover,
    &:focus {
      opacity: 1;
    }
  }`;
const behavior = `
  ${new Array(21).fill(0).map((_, idx) => {
	return `.behavior-ho-${idx * 5} {
          --opacity: ${idx / 20};
          ${opacityBehavior}
        }`;
}).join("\n")}

  .behavior-o-s {
    overflow: scroll;
  }

  .behavior-o-a {
    overflow: auto;
  }

  .behavior-o-h {
    overflow: hidden;
  }

  .behavior-sw-n {
    scrollbar-width: none;
  }
`;
const border = `
  ${new Array(25).fill(0).map((_, idx) => {
	return `
        .border-bw-${idx} { border-width: ${idx}px; }
        .border-btw-${idx} { border-top-width: ${idx}px; }
        .border-bbw-${idx} { border-bottom-width: ${idx}px; }
        .border-blw-${idx} { border-left-width: ${idx}px; }
        .border-brw-${idx} { border-right-width: ${idx}px; }

        .border-ow-${idx} { outline-width: ${idx}px; }
        .border-br-${idx} { border-radius: ${idx * 4}px; overflow: hidden;}`;
}).join("\n")}

  .border-br-50pc {
    border-radius: 50%;
  }

  .border-bs-s {
    border-style: solid;
  }
`;
const shades = [
	0,
	5,
	10,
	15,
	20,
	25,
	30,
	35,
	40,
	50,
	60,
	70,
	80,
	90,
	95,
	98,
	99,
	100
];
function merge(...classes) {
	const styles = {};
	for (const clazz of classes) for (const [key, val] of Object.entries(clazz)) {
		const prefix = key.split("-").with(-1, "").join("-");
		const existingKeys = Object.keys(styles).filter((key) => key.startsWith(prefix));
		for (const existingKey of existingKeys) delete styles[existingKey];
		styles[key] = val;
	}
	return styles;
}
function appendToAll(target, exclusions, ...classes) {
	const updatedTarget = structuredClone(target);
	for (const clazz of classes) for (const key of Object.keys(clazz)) {
		const prefix = key.split("-").with(-1, "").join("-");
		for (const [tagName, classesToAdd] of Object.entries(updatedTarget)) {
			if (exclusions.includes(tagName)) continue;
			let found = false;
			for (let t = 0; t < classesToAdd.length; t++) if (classesToAdd[t].startsWith(prefix)) {
				found = true;
				classesToAdd[t] = key;
			}
			if (!found) classesToAdd.push(key);
		}
	}
	return updatedTarget;
}
function toProp(key) {
	if (key.startsWith("nv")) return `--nv-${key.slice(2)}`;
	return `--${key[0]}-${key.slice(1)}`;
}
const color = (src) => `
    ${src.map((key) => {
	const inverseKey = getInverseKey(key);
	return `.color-bc-${key} { border-color: light-dark(var(${toProp(key)}), var(${toProp(inverseKey)})); }`;
}).join("\n")}

    ${src.map((key) => {
	const inverseKey = getInverseKey(key);
	const vals = [`.color-bgc-${key} { background-color: light-dark(var(${toProp(key)}), var(${toProp(inverseKey)})); }`, `.color-bbgc-${key}::backdrop { background-color: light-dark(var(${toProp(key)}), var(${toProp(inverseKey)})); }`];
	for (let o = .1; o < 1; o += .1) vals.push(`.color-bbgc-${key}_${(o * 100).toFixed(0)}::backdrop {
            background-color: light-dark(oklch(from var(${toProp(key)}) l c h / calc(alpha * ${o.toFixed(1)})), oklch(from var(${toProp(inverseKey)}) l c h / calc(alpha * ${o.toFixed(1)})) );
          }
        `);
	return vals.join("\n");
}).join("\n")}

  ${src.map((key) => {
	const inverseKey = getInverseKey(key);
	return `.color-c-${key} { color: light-dark(var(${toProp(key)}), var(${toProp(inverseKey)})); }`;
}).join("\n")}
  `;
const getInverseKey = (key) => {
	const match = key.match(/^([a-z]+)(\d+)$/);
	if (!match) return key;
	const [, prefix, shadeStr] = match;
	const target = 100 - parseInt(shadeStr, 10);
	return `${prefix}${shades.reduce((prev, curr) => Math.abs(curr - target) < Math.abs(prev - target) ? curr : prev)}`;
};
const keyFactory = (prefix) => {
	return shades.map((v) => `${prefix}${v}`);
};
const structuralStyles$1 = [
	behavior,
	border,
	[
		color(keyFactory("p")),
		color(keyFactory("s")),
		color(keyFactory("t")),
		color(keyFactory("n")),
		color(keyFactory("nv")),
		color(keyFactory("e")),
		`
    .color-bgc-transparent {
      background-color: transparent;
    }

    :host {
      color-scheme: var(--color-scheme);
    }
  `
	],
	`
  .g-icon {
    font-family: "Material Symbols Outlined", "Google Symbols";
    font-weight: normal;
    font-style: normal;
    font-display: optional;
    font-size: 20px;
    width: 1em;
    height: 1em;
    user-select: none;
    line-height: 1;
    letter-spacing: normal;
    text-transform: none;
    display: inline-block;
    white-space: nowrap;
    word-wrap: normal;
    direction: ltr;
    -webkit-font-feature-settings: "liga";
    -webkit-font-smoothing: antialiased;
    overflow: hidden;

    font-variation-settings: "FILL" 0, "wght" 300, "GRAD" 0, "opsz" 48,
      "ROND" 100;

    &.filled {
      font-variation-settings: "FILL" 1, "wght" 300, "GRAD" 0, "opsz" 48,
        "ROND" 100;
    }

    &.filled-heavy {
      font-variation-settings: "FILL" 1, "wght" 700, "GRAD" 0, "opsz" 48,
        "ROND" 100;
    }
  }
`,
	`
  :host {
    ${new Array(16).fill(0).map((_, idx) => {
		return `--g-${idx + 1}: ${(idx + 1) * 4}px;`;
	}).join("\n")}
  }

  ${new Array(49).fill(0).map((_, index) => {
		const idx = index - 24;
		const lbl = idx < 0 ? `n${Math.abs(idx)}` : idx.toString();
		return `
        .layout-p-${lbl} { --padding: ${idx * 4}px; padding: var(--padding); }
        .layout-pt-${lbl} { padding-top: ${idx * 4}px; }
        .layout-pr-${lbl} { padding-right: ${idx * 4}px; }
        .layout-pb-${lbl} { padding-bottom: ${idx * 4}px; }
        .layout-pl-${lbl} { padding-left: ${idx * 4}px; }

        .layout-m-${lbl} { --margin: ${idx * 4}px; margin: var(--margin); }
        .layout-mt-${lbl} { margin-top: ${idx * 4}px; }
        .layout-mr-${lbl} { margin-right: ${idx * 4}px; }
        .layout-mb-${lbl} { margin-bottom: ${idx * 4}px; }
        .layout-ml-${lbl} { margin-left: ${idx * 4}px; }

        .layout-t-${lbl} { top: ${idx * 4}px; }
        .layout-r-${lbl} { right: ${idx * 4}px; }
        .layout-b-${lbl} { bottom: ${idx * 4}px; }
        .layout-l-${lbl} { left: ${idx * 4}px; }`;
	}).join("\n")}

  ${new Array(25).fill(0).map((_, idx) => {
		return `
        .layout-g-${idx} { gap: ${idx * 4}px; }`;
	}).join("\n")}

  ${new Array(8).fill(0).map((_, idx) => {
		return `
        .layout-grd-col${idx + 1} { grid-template-columns: ${"1fr ".repeat(idx + 1).trim()}; }`;
	}).join("\n")}

  .layout-pos-a {
    position: absolute;
  }

  .layout-pos-rel {
    position: relative;
  }

  .layout-dsp-none {
    display: none;
  }

  .layout-dsp-block {
    display: block;
  }

  .layout-dsp-grid {
    display: grid;
  }

  .layout-dsp-iflex {
    display: inline-flex;
  }

  .layout-dsp-flexvert {
    display: flex;
    flex-direction: column;
  }

  .layout-dsp-flexhor {
    display: flex;
    flex-direction: row;
  }

  .layout-fw-w {
    flex-wrap: wrap;
  }

  .layout-al-fs {
    align-items: start;
  }

  .layout-al-fe {
    align-items: end;
  }

  .layout-al-c {
    align-items: center;
  }

  .layout-as-n {
    align-self: normal;
  }

  .layout-js-c {
    justify-self: center;
  }

  .layout-sp-c {
    justify-content: center;
  }

  .layout-sp-ev {
    justify-content: space-evenly;
  }

  .layout-sp-bt {
    justify-content: space-between;
  }

  .layout-sp-s {
    justify-content: start;
  }

  .layout-sp-e {
    justify-content: end;
  }

  .layout-ji-e {
    justify-items: end;
  }

  .layout-r-none {
    resize: none;
  }

  .layout-fs-c {
    field-sizing: content;
  }

  .layout-fs-n {
    field-sizing: none;
  }

  .layout-flx-0 {
    flex: 0 0 auto;
  }

  .layout-flx-1 {
    flex: 1 0 auto;
  }

  .layout-c-s {
    contain: strict;
  }

  /** Widths **/

  ${new Array(10).fill(0).map((_, idx) => {
		const weight = (idx + 1) * 10;
		return `.layout-w-${weight} { width: ${weight}%; max-width: ${weight}%; }`;
	}).join("\n")}

  ${new Array(16).fill(0).map((_, idx) => {
		return `.layout-wp-${idx} { width: ${idx * 4}px; }`;
	}).join("\n")}

  /** Heights **/

  ${new Array(10).fill(0).map((_, idx) => {
		const height = (idx + 1) * 10;
		return `.layout-h-${height} { height: ${height}%; }`;
	}).join("\n")}

  ${new Array(16).fill(0).map((_, idx) => {
		return `.layout-hp-${idx} { height: ${idx * 4}px; }`;
	}).join("\n")}

  .layout-el-cv {
    & img,
    & video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      margin: 0;
    }
  }

  .layout-ar-sq {
    aspect-ratio: 1 / 1;
  }

  .layout-ex-fb {
    margin: calc(var(--padding) * -1) 0 0 calc(var(--padding) * -1);
    width: calc(100% + var(--padding) * 2);
    height: calc(100% + var(--padding) * 2);
  }
`,
	`
  ${new Array(21).fill(0).map((_, idx) => {
		return `.opacity-el-${idx * 5} { opacity: ${idx / 20}; }`;
	}).join("\n")}
`,
	`
  :host {
    --default-font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    --default-font-family-mono: "Courier New", Courier, monospace;
  }

  .typography-f-s {
    font-family: var(--font-family, var(--default-font-family));
    font-optical-sizing: auto;
    font-variation-settings: "slnt" 0, "wdth" 100, "GRAD" 0;
  }

  .typography-f-sf {
    font-family: var(--font-family-flex, var(--default-font-family));
    font-optical-sizing: auto;
  }

  .typography-f-c {
    font-family: var(--font-family-mono, var(--default-font-family));
    font-optical-sizing: auto;
    font-variation-settings: "slnt" 0, "wdth" 100, "GRAD" 0;
  }

  .typography-v-r {
    font-variation-settings: "slnt" 0, "wdth" 100, "GRAD" 0, "ROND" 100;
  }

  .typography-ta-s {
    text-align: start;
  }

  .typography-ta-c {
    text-align: center;
  }

  .typography-fs-n {
    font-style: normal;
  }

  .typography-fs-i {
    font-style: italic;
  }

  .typography-sz-ls {
    font-size: 11px;
    line-height: 16px;
  }

  .typography-sz-lm {
    font-size: 12px;
    line-height: 16px;
  }

  .typography-sz-ll {
    font-size: 14px;
    line-height: 20px;
  }

  .typography-sz-bs {
    font-size: 12px;
    line-height: 16px;
  }

  .typography-sz-bm {
    font-size: 14px;
    line-height: 20px;
  }

  .typography-sz-bl {
    font-size: 16px;
    line-height: 24px;
  }

  .typography-sz-ts {
    font-size: 14px;
    line-height: 20px;
  }

  .typography-sz-tm {
    font-size: 16px;
    line-height: 24px;
  }

  .typography-sz-tl {
    font-size: 22px;
    line-height: 28px;
  }

  .typography-sz-hs {
    font-size: 24px;
    line-height: 32px;
  }

  .typography-sz-hm {
    font-size: 28px;
    line-height: 36px;
  }

  .typography-sz-hl {
    font-size: 32px;
    line-height: 40px;
  }

  .typography-sz-ds {
    font-size: 36px;
    line-height: 44px;
  }

  .typography-sz-dm {
    font-size: 45px;
    line-height: 52px;
  }

  .typography-sz-dl {
    font-size: 57px;
    line-height: 64px;
  }

  .typography-ws-p {
    white-space: pre-line;
  }

  .typography-ws-nw {
    white-space: nowrap;
  }

  .typography-td-none {
    text-decoration: none;
  }

  /** Weights **/

  ${new Array(9).fill(0).map((_, idx) => {
		const weight = (idx + 1) * 100;
		return `.typography-w-${weight} { font-weight: ${weight}; }`;
	}).join("\n")}
`
].flat(Infinity).join("\n");
var guards_exports = /* @__PURE__ */ __exportAll({
	isComponentArrayReference: () => isComponentArrayReference,
	isObject: () => isObject$1,
	isPath: () => isPath,
	isResolvedAudioPlayer: () => isResolvedAudioPlayer,
	isResolvedButton: () => isResolvedButton,
	isResolvedCard: () => isResolvedCard,
	isResolvedCheckbox: () => isResolvedCheckbox,
	isResolvedColumn: () => isResolvedColumn,
	isResolvedDateTimeInput: () => isResolvedDateTimeInput,
	isResolvedDivider: () => isResolvedDivider,
	isResolvedIcon: () => isResolvedIcon,
	isResolvedImage: () => isResolvedImage,
	isResolvedList: () => isResolvedList,
	isResolvedModal: () => isResolvedModal,
	isResolvedMultipleChoice: () => isResolvedMultipleChoice,
	isResolvedRow: () => isResolvedRow,
	isResolvedSlider: () => isResolvedSlider,
	isResolvedTabs: () => isResolvedTabs,
	isResolvedText: () => isResolvedText,
	isResolvedTextField: () => isResolvedTextField,
	isResolvedVideo: () => isResolvedVideo,
	isValueMap: () => isValueMap
});
function isValueMap(value) {
	return isObject$1(value) && "key" in value;
}
function isPath(key, value) {
	return key === "path" && typeof value === "string";
}
function isObject$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isComponentArrayReference(value) {
	if (!isObject$1(value)) return false;
	return "explicitList" in value || "template" in value;
}
function isStringValue(value) {
	return isObject$1(value) && ("path" in value || "literal" in value && typeof value.literal === "string" || "literalString" in value);
}
function isNumberValue(value) {
	return isObject$1(value) && ("path" in value || "literal" in value && typeof value.literal === "number" || "literalNumber" in value);
}
function isBooleanValue(value) {
	return isObject$1(value) && ("path" in value || "literal" in value && typeof value.literal === "boolean" || "literalBoolean" in value);
}
function isAnyComponentNode(value) {
	if (!isObject$1(value)) return false;
	if (!("id" in value && "type" in value && "properties" in value)) return false;
	return true;
}
function isResolvedAudioPlayer(props) {
	return isObject$1(props) && "url" in props && isStringValue(props.url);
}
function isResolvedButton(props) {
	return isObject$1(props) && "child" in props && isAnyComponentNode(props.child) && "action" in props;
}
function isResolvedCard(props) {
	if (!isObject$1(props)) return false;
	if (!("child" in props)) if (!("children" in props)) return false;
	else return Array.isArray(props.children) && props.children.every(isAnyComponentNode);
	return isAnyComponentNode(props.child);
}
function isResolvedCheckbox(props) {
	return isObject$1(props) && "label" in props && isStringValue(props.label) && "value" in props && isBooleanValue(props.value);
}
function isResolvedColumn(props) {
	return isObject$1(props) && "children" in props && Array.isArray(props.children) && props.children.every(isAnyComponentNode);
}
function isResolvedDateTimeInput(props) {
	return isObject$1(props) && "value" in props && isStringValue(props.value);
}
function isResolvedDivider(props) {
	return isObject$1(props);
}
function isResolvedImage(props) {
	return isObject$1(props) && "url" in props && isStringValue(props.url);
}
function isResolvedIcon(props) {
	return isObject$1(props) && "name" in props && isStringValue(props.name);
}
function isResolvedList(props) {
	return isObject$1(props) && "children" in props && Array.isArray(props.children) && props.children.every(isAnyComponentNode);
}
function isResolvedModal(props) {
	return isObject$1(props) && "entryPointChild" in props && isAnyComponentNode(props.entryPointChild) && "contentChild" in props && isAnyComponentNode(props.contentChild);
}
function isResolvedMultipleChoice(props) {
	return isObject$1(props) && "selections" in props;
}
function isResolvedRow(props) {
	return isObject$1(props) && "children" in props && Array.isArray(props.children) && props.children.every(isAnyComponentNode);
}
function isResolvedSlider(props) {
	return isObject$1(props) && "value" in props && isNumberValue(props.value);
}
function isResolvedTabItem(item) {
	return isObject$1(item) && "title" in item && isStringValue(item.title) && "child" in item && isAnyComponentNode(item.child);
}
function isResolvedTabs(props) {
	return isObject$1(props) && "tabItems" in props && Array.isArray(props.tabItems) && props.tabItems.every(isResolvedTabItem);
}
function isResolvedText(props) {
	return isObject$1(props) && "text" in props && isStringValue(props.text);
}
function isResolvedTextField(props) {
	return isObject$1(props) && "label" in props && isStringValue(props.label);
}
function isResolvedVideo(props) {
	return isObject$1(props) && "url" in props && isStringValue(props.url);
}
/**
* Processes and consolidates A2UIProtocolMessage objects into a structured,
* hierarchical model of UI surfaces.
*/
var A2uiMessageProcessor = class A2uiMessageProcessor {
	static {
		this.DEFAULT_SURFACE_ID = "@default";
	}
	#mapCtor = Map;
	#arrayCtor = Array;
	#setCtor = Set;
	#objCtor = Object;
	#surfaces;
	constructor(opts = {
		mapCtor: Map,
		arrayCtor: Array,
		setCtor: Set,
		objCtor: Object
	}) {
		this.opts = opts;
		this.#arrayCtor = opts.arrayCtor;
		this.#mapCtor = opts.mapCtor;
		this.#setCtor = opts.setCtor;
		this.#objCtor = opts.objCtor;
		this.#surfaces = new opts.mapCtor();
	}
	getSurfaces() {
		return this.#surfaces;
	}
	clearSurfaces() {
		this.#surfaces.clear();
	}
	processMessages(messages) {
		for (const message of messages) {
			if (message.beginRendering) this.#handleBeginRendering(message.beginRendering, message.beginRendering.surfaceId);
			if (message.surfaceUpdate) this.#handleSurfaceUpdate(message.surfaceUpdate, message.surfaceUpdate.surfaceId);
			if (message.dataModelUpdate) this.#handleDataModelUpdate(message.dataModelUpdate, message.dataModelUpdate.surfaceId);
			if (message.deleteSurface) this.#handleDeleteSurface(message.deleteSurface);
		}
	}
	/**
	* Retrieves the data for a given component node and a relative path string.
	* This correctly handles the special `.` path, which refers to the node's
	* own data context.
	*/
	getData(node, relativePath, surfaceId = A2uiMessageProcessor.DEFAULT_SURFACE_ID) {
		const surface = this.#getOrCreateSurface(surfaceId);
		if (!surface) return null;
		let finalPath;
		if (relativePath === "." || relativePath === "") finalPath = node.dataContextPath ?? "/";
		else finalPath = this.resolvePath(relativePath, node.dataContextPath);
		return this.#getDataByPath(surface.dataModel, finalPath);
	}
	setData(node, relativePath, value, surfaceId = A2uiMessageProcessor.DEFAULT_SURFACE_ID) {
		if (!node) {
			console.warn("No component node set");
			return;
		}
		const surface = this.#getOrCreateSurface(surfaceId);
		if (!surface) return;
		let finalPath;
		if (relativePath === "." || relativePath === "") finalPath = node.dataContextPath ?? "/";
		else finalPath = this.resolvePath(relativePath, node.dataContextPath);
		this.#setDataByPath(surface.dataModel, finalPath, value);
	}
	resolvePath(path, dataContextPath) {
		if (path.startsWith("/")) return path;
		if (dataContextPath && dataContextPath !== "/") return dataContextPath.endsWith("/") ? `${dataContextPath}${path}` : `${dataContextPath}/${path}`;
		return `/${path}`;
	}
	#parseIfJsonString(value) {
		if (typeof value !== "string") return value;
		const trimmedValue = value.trim();
		if (trimmedValue.startsWith("{") && trimmedValue.endsWith("}") || trimmedValue.startsWith("[") && trimmedValue.endsWith("]")) try {
			return JSON.parse(value);
		} catch (e) {
			console.warn(`Failed to parse potential JSON string: "${value.substring(0, 50)}..."`, e);
			return value;
		}
		return value;
	}
	/**
	* Converts a specific array format [{key: "...", value_string: "..."}, ...]
	* into a standard Map. It also attempts to parse any string values that
	* appear to be stringified JSON.
	*/
	#convertKeyValueArrayToMap(arr) {
		const map = new this.#mapCtor();
		for (const item of arr) {
			if (!isObject$1(item) || !("key" in item)) continue;
			const key = item.key;
			const valueKey = this.#findValueKey(item);
			if (!valueKey) continue;
			let value = item[valueKey];
			if (valueKey === "valueMap" && Array.isArray(value)) value = this.#convertKeyValueArrayToMap(value);
			else if (typeof value === "string") value = this.#parseIfJsonString(value);
			this.#setDataByPath(map, key, value);
		}
		return map;
	}
	#setDataByPath(root, path, value) {
		if (Array.isArray(value) && (value.length === 0 || isObject$1(value[0]) && "key" in value[0])) if (value.length === 1 && isObject$1(value[0]) && value[0].key === ".") {
			const item = value[0];
			const valueKey = this.#findValueKey(item);
			if (valueKey) {
				value = item[valueKey];
				if (valueKey === "valueMap" && Array.isArray(value)) value = this.#convertKeyValueArrayToMap(value);
				else if (typeof value === "string") value = this.#parseIfJsonString(value);
			} else value = this.#convertKeyValueArrayToMap(value);
		} else value = this.#convertKeyValueArrayToMap(value);
		const segments = this.#normalizePath(path).split("/").filter((s) => s);
		if (segments.length === 0) {
			if (value instanceof Map || isObject$1(value)) {
				if (!(value instanceof Map) && isObject$1(value)) value = new this.#mapCtor(Object.entries(value));
				root.clear();
				for (const [key, v] of value.entries()) root.set(key, v);
			} else console.error("Cannot set root of DataModel to a non-Map value.");
			return;
		}
		let current = root;
		for (let i = 0; i < segments.length - 1; i++) {
			const segment = segments[i];
			let target;
			if (current instanceof Map) target = current.get(segment);
			else if (Array.isArray(current) && /^\d+$/.test(segment)) target = current[parseInt(segment, 10)];
			if (target === void 0 || typeof target !== "object" || target === null) {
				target = new this.#mapCtor();
				if (current instanceof this.#mapCtor) current.set(segment, target);
				else if (Array.isArray(current)) current[parseInt(segment, 10)] = target;
			}
			current = target;
		}
		const finalSegment = segments[segments.length - 1];
		const storedValue = value;
		if (current instanceof this.#mapCtor) current.set(finalSegment, storedValue);
		else if (Array.isArray(current) && /^\d+$/.test(finalSegment)) current[parseInt(finalSegment, 10)] = storedValue;
	}
	/**
	* Normalizes a path string into a consistent, slash-delimited format.
	* Converts bracket notation and dot notation in a two-pass.
	* e.g., "bookRecommendations[0].title" -> "/bookRecommendations/0/title"
	* e.g., "book.0.title" -> "/book/0/title"
	*/
	#normalizePath(path) {
		return "/" + path.replace(/\[(\d+)\]/g, ".$1").split(".").filter((s) => s.length > 0).join("/");
	}
	#getDataByPath(root, path) {
		const segments = this.#normalizePath(path).split("/").filter((s) => s);
		let current = root;
		for (const segment of segments) {
			if (current === void 0 || current === null) return null;
			if (current instanceof Map) current = current.get(segment);
			else if (Array.isArray(current) && /^\d+$/.test(segment)) current = current[parseInt(segment, 10)];
			else if (isObject$1(current)) current = current[segment];
			else return null;
		}
		return current;
	}
	#getOrCreateSurface(surfaceId) {
		let surface = this.#surfaces.get(surfaceId);
		if (!surface) {
			surface = new this.#objCtor({
				rootComponentId: null,
				componentTree: null,
				dataModel: new this.#mapCtor(),
				components: new this.#mapCtor(),
				styles: new this.#objCtor()
			});
			this.#surfaces.set(surfaceId, surface);
		}
		return surface;
	}
	#handleBeginRendering(message, surfaceId) {
		const surface = this.#getOrCreateSurface(surfaceId);
		surface.rootComponentId = message.root;
		surface.styles = message.styles ?? {};
		this.#rebuildComponentTree(surface);
	}
	#handleSurfaceUpdate(message, surfaceId) {
		const surface = this.#getOrCreateSurface(surfaceId);
		for (const component of message.components) surface.components.set(component.id, component);
		this.#rebuildComponentTree(surface);
	}
	#handleDataModelUpdate(message, surfaceId) {
		const surface = this.#getOrCreateSurface(surfaceId);
		const path = message.path ?? "/";
		this.#setDataByPath(surface.dataModel, path, message.contents);
		this.#rebuildComponentTree(surface);
	}
	#handleDeleteSurface(message) {
		this.#surfaces.delete(message.surfaceId);
	}
	/**
	* Starts at the root component of the surface and builds out the tree
	* recursively. This process involves resolving all properties of the child
	* components, and expanding on any explicit children lists or templates
	* found in the structure.
	*
	* @param surface The surface to be built.
	*/
	#rebuildComponentTree(surface) {
		if (!surface.rootComponentId) {
			surface.componentTree = null;
			return;
		}
		const visited = new this.#setCtor();
		surface.componentTree = this.#buildNodeRecursive(surface.rootComponentId, surface, visited, "/", "");
	}
	/** Finds a value key in a map. */
	#findValueKey(value) {
		return Object.keys(value).find((k) => k.startsWith("value"));
	}
	/**
	* Builds out the nodes recursively.
	*/
	#buildNodeRecursive(baseComponentId, surface, visited, dataContextPath, idSuffix = "") {
		const fullId = `${baseComponentId}${idSuffix}`;
		const { components } = surface;
		if (!components.has(baseComponentId)) return null;
		if (visited.has(fullId)) throw new Error(`Circular dependency for component "${fullId}".`);
		visited.add(fullId);
		const componentData = components.get(baseComponentId);
		const componentProps = componentData.component ?? {};
		const componentType = Object.keys(componentProps)[0];
		const unresolvedProperties = componentProps[componentType];
		const resolvedProperties = new this.#objCtor();
		if (isObject$1(unresolvedProperties)) for (const [key, value] of Object.entries(unresolvedProperties)) resolvedProperties[key] = this.#resolvePropertyValue(value, surface, visited, dataContextPath, idSuffix, key);
		visited.delete(fullId);
		const baseNode = {
			id: fullId,
			dataContextPath,
			weight: componentData.weight ?? "initial"
		};
		switch (componentType) {
			case "Text":
				if (!isResolvedText(resolvedProperties)) throw new Error(`Invalid data; expected ${componentType}`);
				return new this.#objCtor({
					...baseNode,
					type: "Text",
					properties: resolvedProperties
				});
			case "Image":
				if (!isResolvedImage(resolvedProperties)) throw new Error(`Invalid data; expected ${componentType}`);
				return new this.#objCtor({
					...baseNode,
					type: "Image",
					properties: resolvedProperties
				});
			case "Icon":
				if (!isResolvedIcon(resolvedProperties)) throw new Error(`Invalid data; expected ${componentType}`);
				return new this.#objCtor({
					...baseNode,
					type: "Icon",
					properties: resolvedProperties
				});
			case "Video":
				if (!isResolvedVideo(resolvedProperties)) throw new Error(`Invalid data; expected ${componentType}`);
				return new this.#objCtor({
					...baseNode,
					type: "Video",
					properties: resolvedProperties
				});
			case "AudioPlayer":
				if (!isResolvedAudioPlayer(resolvedProperties)) throw new Error(`Invalid data; expected ${componentType}`);
				return new this.#objCtor({
					...baseNode,
					type: "AudioPlayer",
					properties: resolvedProperties
				});
			case "Row":
				if (!isResolvedRow(resolvedProperties)) throw new Error(`Invalid data; expected ${componentType}`);
				return new this.#objCtor({
					...baseNode,
					type: "Row",
					properties: resolvedProperties
				});
			case "Column":
				if (!isResolvedColumn(resolvedProperties)) throw new Error(`Invalid data; expected ${componentType}`);
				return new this.#objCtor({
					...baseNode,
					type: "Column",
					properties: resolvedProperties
				});
			case "List":
				if (!isResolvedList(resolvedProperties)) throw new Error(`Invalid data; expected ${componentType}`);
				return new this.#objCtor({
					...baseNode,
					type: "List",
					properties: resolvedProperties
				});
			case "Card":
				if (!isResolvedCard(resolvedProperties)) throw new Error(`Invalid data; expected ${componentType}`);
				return new this.#objCtor({
					...baseNode,
					type: "Card",
					properties: resolvedProperties
				});
			case "Tabs":
				if (!isResolvedTabs(resolvedProperties)) throw new Error(`Invalid data; expected ${componentType}`);
				return new this.#objCtor({
					...baseNode,
					type: "Tabs",
					properties: resolvedProperties
				});
			case "Divider":
				if (!isResolvedDivider(resolvedProperties)) throw new Error(`Invalid data; expected ${componentType}`);
				return new this.#objCtor({
					...baseNode,
					type: "Divider",
					properties: resolvedProperties
				});
			case "Modal":
				if (!isResolvedModal(resolvedProperties)) throw new Error(`Invalid data; expected ${componentType}`);
				return new this.#objCtor({
					...baseNode,
					type: "Modal",
					properties: resolvedProperties
				});
			case "Button":
				if (!isResolvedButton(resolvedProperties)) throw new Error(`Invalid data; expected ${componentType}`);
				return new this.#objCtor({
					...baseNode,
					type: "Button",
					properties: resolvedProperties
				});
			case "CheckBox":
				if (!isResolvedCheckbox(resolvedProperties)) throw new Error(`Invalid data; expected ${componentType}`);
				return new this.#objCtor({
					...baseNode,
					type: "CheckBox",
					properties: resolvedProperties
				});
			case "TextField":
				if (!isResolvedTextField(resolvedProperties)) throw new Error(`Invalid data; expected ${componentType}`);
				return new this.#objCtor({
					...baseNode,
					type: "TextField",
					properties: resolvedProperties
				});
			case "DateTimeInput":
				if (!isResolvedDateTimeInput(resolvedProperties)) throw new Error(`Invalid data; expected ${componentType}`);
				return new this.#objCtor({
					...baseNode,
					type: "DateTimeInput",
					properties: resolvedProperties
				});
			case "MultipleChoice":
				if (!isResolvedMultipleChoice(resolvedProperties)) throw new Error(`Invalid data; expected ${componentType}`);
				return new this.#objCtor({
					...baseNode,
					type: "MultipleChoice",
					properties: resolvedProperties
				});
			case "Slider":
				if (!isResolvedSlider(resolvedProperties)) throw new Error(`Invalid data; expected ${componentType}`);
				return new this.#objCtor({
					...baseNode,
					type: "Slider",
					properties: resolvedProperties
				});
			default: return new this.#objCtor({
				...baseNode,
				type: componentType,
				properties: resolvedProperties
			});
		}
	}
	/**
	* Recursively resolves an individual property value. If a property indicates
	* a child node (a string that matches a component ID), an explicitList of
	* children, or a template, these will be built out here.
	*/
	#resolvePropertyValue(value, surface, visited, dataContextPath, idSuffix = "", propertyKey = null) {
		const isComponentIdReferenceKey = (key) => key === "child" || key.endsWith("Child");
		if (typeof value === "string" && propertyKey && isComponentIdReferenceKey(propertyKey) && surface.components.has(value)) return this.#buildNodeRecursive(value, surface, visited, dataContextPath, idSuffix);
		if (isComponentArrayReference(value)) {
			if (value.explicitList) return value.explicitList.map((id) => this.#buildNodeRecursive(id, surface, visited, dataContextPath, idSuffix));
			if (value.template) {
				const fullDataPath = this.resolvePath(value.template.dataBinding, dataContextPath);
				const data = this.#getDataByPath(surface.dataModel, fullDataPath);
				const template = value.template;
				if (Array.isArray(data)) return data.map((_, index) => {
					const newSuffix = `:${[...dataContextPath.split("/").filter((segment) => /^\d+$/.test(segment)), index].join(":")}`;
					const childDataContextPath = `${fullDataPath}/${index}`;
					return this.#buildNodeRecursive(template.componentId, surface, visited, childDataContextPath, newSuffix);
				});
				if (data instanceof this.#mapCtor) return Array.from(data.keys(), (key) => {
					const newSuffix = `:${key}`;
					const childDataContextPath = `${fullDataPath}/${key}`;
					return this.#buildNodeRecursive(template.componentId, surface, visited, childDataContextPath, newSuffix);
				});
				return new this.#arrayCtor();
			}
		}
		if (Array.isArray(value)) return value.map((item) => this.#resolvePropertyValue(item, surface, visited, dataContextPath, idSuffix, propertyKey));
		if (isObject$1(value)) {
			const newObj = new this.#objCtor();
			for (const [key, propValue] of Object.entries(value)) {
				let propertyValue = propValue;
				if (isPath(key, propValue) && dataContextPath !== "/") {
					propertyValue = propValue.replace(/^\.?\/item/, "").replace(/^\.?\/text/, "").replace(/^\.?\/label/, "").replace(/^\.?\//, "");
					newObj[key] = propertyValue;
					continue;
				}
				newObj[key] = this.#resolvePropertyValue(propertyValue, surface, visited, dataContextPath, idSuffix, key);
			}
			return newObj;
		}
		return value;
	}
};
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, {
	enumerable: true,
	configurable: true,
	writable: true,
	value
}) : obj[key] = value;
var __publicField = (obj, key, value) => {
	__defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
	return value;
};
var __accessCheck = (obj, member, msg) => {
	if (!member.has(obj)) throw TypeError("Cannot " + msg);
};
var __privateIn = (member, obj) => {
	if (Object(obj) !== obj) throw TypeError("Cannot use the \"in\" operator on this value");
	return member.has(obj);
};
var __privateAdd = (obj, member, value) => {
	if (member.has(obj)) throw TypeError("Cannot add the same private member more than once");
	member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
};
var __privateMethod = (obj, member, method) => {
	__accessCheck(obj, member, "access private method");
	return method;
};
/**
* @license
* Copyright Google LLC All Rights Reserved.
*
* Use of this source code is governed by an MIT-style license that can be
* found in the LICENSE file at https://angular.io/license
*/
function defaultEquals(a, b) {
	return Object.is(a, b);
}
/**
* @license
* Copyright Google LLC All Rights Reserved.
*
* Use of this source code is governed by an MIT-style license that can be
* found in the LICENSE file at https://angular.io/license
*/
let activeConsumer = null;
let inNotificationPhase = false;
let epoch = 1;
const SIGNAL = /* @__PURE__ */ Symbol("SIGNAL");
function setActiveConsumer(consumer) {
	const prev = activeConsumer;
	activeConsumer = consumer;
	return prev;
}
function getActiveConsumer() {
	return activeConsumer;
}
function isInNotificationPhase() {
	return inNotificationPhase;
}
const REACTIVE_NODE = {
	version: 0,
	lastCleanEpoch: 0,
	dirty: false,
	producerNode: void 0,
	producerLastReadVersion: void 0,
	producerIndexOfThis: void 0,
	nextProducerIndex: 0,
	liveConsumerNode: void 0,
	liveConsumerIndexOfThis: void 0,
	consumerAllowSignalWrites: false,
	consumerIsAlwaysLive: false,
	producerMustRecompute: () => false,
	producerRecomputeValue: () => {},
	consumerMarkedDirty: () => {},
	consumerOnSignalRead: () => {}
};
function producerAccessed(node) {
	if (inNotificationPhase) throw new Error(typeof ngDevMode !== "undefined" && ngDevMode ? `Assertion error: signal read during notification phase` : "");
	if (activeConsumer === null) return;
	activeConsumer.consumerOnSignalRead(node);
	const idx = activeConsumer.nextProducerIndex++;
	assertConsumerNode(activeConsumer);
	if (idx < activeConsumer.producerNode.length && activeConsumer.producerNode[idx] !== node) {
		if (consumerIsLive(activeConsumer)) {
			const staleProducer = activeConsumer.producerNode[idx];
			producerRemoveLiveConsumerAtIndex(staleProducer, activeConsumer.producerIndexOfThis[idx]);
		}
	}
	if (activeConsumer.producerNode[idx] !== node) {
		activeConsumer.producerNode[idx] = node;
		activeConsumer.producerIndexOfThis[idx] = consumerIsLive(activeConsumer) ? producerAddLiveConsumer(node, activeConsumer, idx) : 0;
	}
	activeConsumer.producerLastReadVersion[idx] = node.version;
}
function producerIncrementEpoch() {
	epoch++;
}
function producerUpdateValueVersion(node) {
	if (!node.dirty && node.lastCleanEpoch === epoch) return;
	if (!node.producerMustRecompute(node) && !consumerPollProducersForChange(node)) {
		node.dirty = false;
		node.lastCleanEpoch = epoch;
		return;
	}
	node.producerRecomputeValue(node);
	node.dirty = false;
	node.lastCleanEpoch = epoch;
}
function producerNotifyConsumers(node) {
	if (node.liveConsumerNode === void 0) return;
	const prev = inNotificationPhase;
	inNotificationPhase = true;
	try {
		for (const consumer of node.liveConsumerNode) if (!consumer.dirty) consumerMarkDirty(consumer);
	} finally {
		inNotificationPhase = prev;
	}
}
function producerUpdatesAllowed() {
	return (activeConsumer == null ? void 0 : activeConsumer.consumerAllowSignalWrites) !== false;
}
function consumerMarkDirty(node) {
	var _a;
	node.dirty = true;
	producerNotifyConsumers(node);
	(_a = node.consumerMarkedDirty) == null || _a.call(node.wrapper ?? node);
}
function consumerBeforeComputation(node) {
	node && (node.nextProducerIndex = 0);
	return setActiveConsumer(node);
}
function consumerAfterComputation(node, prevConsumer) {
	setActiveConsumer(prevConsumer);
	if (!node || node.producerNode === void 0 || node.producerIndexOfThis === void 0 || node.producerLastReadVersion === void 0) return;
	if (consumerIsLive(node)) for (let i = node.nextProducerIndex; i < node.producerNode.length; i++) producerRemoveLiveConsumerAtIndex(node.producerNode[i], node.producerIndexOfThis[i]);
	while (node.producerNode.length > node.nextProducerIndex) {
		node.producerNode.pop();
		node.producerLastReadVersion.pop();
		node.producerIndexOfThis.pop();
	}
}
function consumerPollProducersForChange(node) {
	assertConsumerNode(node);
	for (let i = 0; i < node.producerNode.length; i++) {
		const producer = node.producerNode[i];
		const seenVersion = node.producerLastReadVersion[i];
		if (seenVersion !== producer.version) return true;
		producerUpdateValueVersion(producer);
		if (seenVersion !== producer.version) return true;
	}
	return false;
}
function producerAddLiveConsumer(node, consumer, indexOfThis) {
	var _a;
	assertProducerNode(node);
	assertConsumerNode(node);
	if (node.liveConsumerNode.length === 0) {
		(_a = node.watched) == null || _a.call(node.wrapper);
		for (let i = 0; i < node.producerNode.length; i++) node.producerIndexOfThis[i] = producerAddLiveConsumer(node.producerNode[i], node, i);
	}
	node.liveConsumerIndexOfThis.push(indexOfThis);
	return node.liveConsumerNode.push(consumer) - 1;
}
function producerRemoveLiveConsumerAtIndex(node, idx) {
	var _a;
	assertProducerNode(node);
	assertConsumerNode(node);
	if (typeof ngDevMode !== "undefined" && ngDevMode && idx >= node.liveConsumerNode.length) throw new Error(`Assertion error: active consumer index ${idx} is out of bounds of ${node.liveConsumerNode.length} consumers)`);
	if (node.liveConsumerNode.length === 1) {
		(_a = node.unwatched) == null || _a.call(node.wrapper);
		for (let i = 0; i < node.producerNode.length; i++) producerRemoveLiveConsumerAtIndex(node.producerNode[i], node.producerIndexOfThis[i]);
	}
	const lastIdx = node.liveConsumerNode.length - 1;
	node.liveConsumerNode[idx] = node.liveConsumerNode[lastIdx];
	node.liveConsumerIndexOfThis[idx] = node.liveConsumerIndexOfThis[lastIdx];
	node.liveConsumerNode.length--;
	node.liveConsumerIndexOfThis.length--;
	if (idx < node.liveConsumerNode.length) {
		const idxProducer = node.liveConsumerIndexOfThis[idx];
		const consumer = node.liveConsumerNode[idx];
		assertConsumerNode(consumer);
		consumer.producerIndexOfThis[idxProducer] = idx;
	}
}
function consumerIsLive(node) {
	var _a;
	return node.consumerIsAlwaysLive || (((_a = node == null ? void 0 : node.liveConsumerNode) == null ? void 0 : _a.length) ?? 0) > 0;
}
function assertConsumerNode(node) {
	node.producerNode ?? (node.producerNode = []);
	node.producerIndexOfThis ?? (node.producerIndexOfThis = []);
	node.producerLastReadVersion ?? (node.producerLastReadVersion = []);
}
function assertProducerNode(node) {
	node.liveConsumerNode ?? (node.liveConsumerNode = []);
	node.liveConsumerIndexOfThis ?? (node.liveConsumerIndexOfThis = []);
}
/**
* @license
* Copyright Google LLC All Rights Reserved.
*
* Use of this source code is governed by an MIT-style license that can be
* found in the LICENSE file at https://angular.io/license
*/
function computedGet(node) {
	producerUpdateValueVersion(node);
	producerAccessed(node);
	if (node.value === ERRORED) throw node.error;
	return node.value;
}
function createComputed(computation) {
	const node = Object.create(COMPUTED_NODE);
	node.computation = computation;
	const computed = () => computedGet(node);
	computed[SIGNAL] = node;
	return computed;
}
const UNSET = /* @__PURE__ */ Symbol("UNSET");
const COMPUTING = /* @__PURE__ */ Symbol("COMPUTING");
const ERRORED = /* @__PURE__ */ Symbol("ERRORED");
const COMPUTED_NODE = {
	...REACTIVE_NODE,
	value: UNSET,
	dirty: true,
	error: null,
	equal: defaultEquals,
	producerMustRecompute(node) {
		return node.value === UNSET || node.value === COMPUTING;
	},
	producerRecomputeValue(node) {
		if (node.value === COMPUTING) throw new Error("Detected cycle in computations.");
		const oldValue = node.value;
		node.value = COMPUTING;
		const prevConsumer = consumerBeforeComputation(node);
		let newValue;
		let wasEqual = false;
		try {
			newValue = node.computation.call(node.wrapper);
			wasEqual = oldValue !== UNSET && oldValue !== ERRORED && node.equal.call(node.wrapper, oldValue, newValue);
		} catch (err) {
			newValue = ERRORED;
			node.error = err;
		} finally {
			consumerAfterComputation(node, prevConsumer);
		}
		if (wasEqual) {
			node.value = oldValue;
			return;
		}
		node.value = newValue;
		node.version++;
	}
};
/**
* @license
* Copyright Google LLC All Rights Reserved.
*
* Use of this source code is governed by an MIT-style license that can be
* found in the LICENSE file at https://angular.io/license
*/
function defaultThrowError() {
	throw new Error();
}
let throwInvalidWriteToSignalErrorFn = defaultThrowError;
function throwInvalidWriteToSignalError() {
	throwInvalidWriteToSignalErrorFn();
}
/**
* @license
* Copyright Google LLC All Rights Reserved.
*
* Use of this source code is governed by an MIT-style license that can be
* found in the LICENSE file at https://angular.io/license
*/
function createSignal(initialValue) {
	const node = Object.create(SIGNAL_NODE);
	node.value = initialValue;
	const getter = () => {
		producerAccessed(node);
		return node.value;
	};
	getter[SIGNAL] = node;
	return getter;
}
function signalGetFn() {
	producerAccessed(this);
	return this.value;
}
function signalSetFn(node, newValue) {
	if (!producerUpdatesAllowed()) throwInvalidWriteToSignalError();
	if (!node.equal.call(node.wrapper, node.value, newValue)) {
		node.value = newValue;
		signalValueChanged(node);
	}
}
const SIGNAL_NODE = {
	...REACTIVE_NODE,
	equal: defaultEquals,
	value: void 0
};
function signalValueChanged(node) {
	node.version++;
	producerIncrementEpoch();
	producerNotifyConsumers(node);
}
/**
* @license
* Copyright 2024 Bloomberg Finance L.P.
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*     http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
const NODE = Symbol("node");
var Signal;
((Signal2) => {
	var _a, _brand, _b, _brand2;
	class State {
		constructor(initialValue, options = {}) {
			__privateAdd(this, _brand);
			__publicField(this, _a);
			const node = createSignal(initialValue)[SIGNAL];
			this[NODE] = node;
			node.wrapper = this;
			if (options) {
				const equals = options.equals;
				if (equals) node.equal = equals;
				node.watched = options[Signal2.subtle.watched];
				node.unwatched = options[Signal2.subtle.unwatched];
			}
		}
		get() {
			if (!(0, Signal2.isState)(this)) throw new TypeError("Wrong receiver type for Signal.State.prototype.get");
			return signalGetFn.call(this[NODE]);
		}
		set(newValue) {
			if (!(0, Signal2.isState)(this)) throw new TypeError("Wrong receiver type for Signal.State.prototype.set");
			if (isInNotificationPhase()) throw new Error("Writes to signals not permitted during Watcher callback");
			const ref = this[NODE];
			signalSetFn(ref, newValue);
		}
	}
	_a = NODE;
	_brand = /* @__PURE__ */ new WeakSet();
	Signal2.isState = (s) => typeof s === "object" && __privateIn(_brand, s);
	Signal2.State = State;
	class Computed {
		constructor(computation, options) {
			__privateAdd(this, _brand2);
			__publicField(this, _b);
			const node = createComputed(computation)[SIGNAL];
			node.consumerAllowSignalWrites = true;
			this[NODE] = node;
			node.wrapper = this;
			if (options) {
				const equals = options.equals;
				if (equals) node.equal = equals;
				node.watched = options[Signal2.subtle.watched];
				node.unwatched = options[Signal2.subtle.unwatched];
			}
		}
		get() {
			if (!(0, Signal2.isComputed)(this)) throw new TypeError("Wrong receiver type for Signal.Computed.prototype.get");
			return computedGet(this[NODE]);
		}
	}
	_b = NODE;
	_brand2 = /* @__PURE__ */ new WeakSet();
	Signal2.isComputed = (c) => typeof c === "object" && __privateIn(_brand2, c);
	Signal2.Computed = Computed;
	((subtle2) => {
		var _a2, _brand3, _assertSignals, assertSignals_fn;
		function untrack(cb) {
			let output;
			let prevActiveConsumer = null;
			try {
				prevActiveConsumer = setActiveConsumer(null);
				output = cb();
			} finally {
				setActiveConsumer(prevActiveConsumer);
			}
			return output;
		}
		subtle2.untrack = untrack;
		function introspectSources(sink) {
			var _a3;
			if (!(0, Signal2.isComputed)(sink) && !(0, Signal2.isWatcher)(sink)) throw new TypeError("Called introspectSources without a Computed or Watcher argument");
			return ((_a3 = sink[NODE].producerNode) == null ? void 0 : _a3.map((n) => n.wrapper)) ?? [];
		}
		subtle2.introspectSources = introspectSources;
		function introspectSinks(signal) {
			var _a3;
			if (!(0, Signal2.isComputed)(signal) && !(0, Signal2.isState)(signal)) throw new TypeError("Called introspectSinks without a Signal argument");
			return ((_a3 = signal[NODE].liveConsumerNode) == null ? void 0 : _a3.map((n) => n.wrapper)) ?? [];
		}
		subtle2.introspectSinks = introspectSinks;
		function hasSinks(signal) {
			if (!(0, Signal2.isComputed)(signal) && !(0, Signal2.isState)(signal)) throw new TypeError("Called hasSinks without a Signal argument");
			const liveConsumerNode = signal[NODE].liveConsumerNode;
			if (!liveConsumerNode) return false;
			return liveConsumerNode.length > 0;
		}
		subtle2.hasSinks = hasSinks;
		function hasSources(signal) {
			if (!(0, Signal2.isComputed)(signal) && !(0, Signal2.isWatcher)(signal)) throw new TypeError("Called hasSources without a Computed or Watcher argument");
			const producerNode = signal[NODE].producerNode;
			if (!producerNode) return false;
			return producerNode.length > 0;
		}
		subtle2.hasSources = hasSources;
		class Watcher {
			constructor(notify) {
				__privateAdd(this, _brand3);
				__privateAdd(this, _assertSignals);
				__publicField(this, _a2);
				let node = Object.create(REACTIVE_NODE);
				node.wrapper = this;
				node.consumerMarkedDirty = notify;
				node.consumerIsAlwaysLive = true;
				node.consumerAllowSignalWrites = false;
				node.producerNode = [];
				this[NODE] = node;
			}
			watch(...signals) {
				if (!(0, Signal2.isWatcher)(this)) throw new TypeError("Called unwatch without Watcher receiver");
				__privateMethod(this, _assertSignals, assertSignals_fn).call(this, signals);
				const node = this[NODE];
				node.dirty = false;
				const prev = setActiveConsumer(node);
				for (const signal of signals) producerAccessed(signal[NODE]);
				setActiveConsumer(prev);
			}
			unwatch(...signals) {
				if (!(0, Signal2.isWatcher)(this)) throw new TypeError("Called unwatch without Watcher receiver");
				__privateMethod(this, _assertSignals, assertSignals_fn).call(this, signals);
				const node = this[NODE];
				assertConsumerNode(node);
				for (let i = node.producerNode.length - 1; i >= 0; i--) if (signals.includes(node.producerNode[i].wrapper)) {
					producerRemoveLiveConsumerAtIndex(node.producerNode[i], node.producerIndexOfThis[i]);
					const lastIdx = node.producerNode.length - 1;
					node.producerNode[i] = node.producerNode[lastIdx];
					node.producerIndexOfThis[i] = node.producerIndexOfThis[lastIdx];
					node.producerNode.length--;
					node.producerIndexOfThis.length--;
					node.nextProducerIndex--;
					if (i < node.producerNode.length) {
						const idxConsumer = node.producerIndexOfThis[i];
						const producer = node.producerNode[i];
						assertProducerNode(producer);
						producer.liveConsumerIndexOfThis[idxConsumer] = i;
					}
				}
			}
			getPending() {
				if (!(0, Signal2.isWatcher)(this)) throw new TypeError("Called getPending without Watcher receiver");
				return this[NODE].producerNode.filter((n) => n.dirty).map((n) => n.wrapper);
			}
		}
		_a2 = NODE;
		_brand3 = /* @__PURE__ */ new WeakSet();
		_assertSignals = /* @__PURE__ */ new WeakSet();
		assertSignals_fn = function(signals) {
			for (const signal of signals) if (!(0, Signal2.isComputed)(signal) && !(0, Signal2.isState)(signal)) throw new TypeError("Called watch/unwatch without a Computed or State argument");
		};
		Signal2.isWatcher = (w) => __privateIn(_brand3, w);
		subtle2.Watcher = Watcher;
		function currentComputed() {
			var _a3;
			return (_a3 = getActiveConsumer()) == null ? void 0 : _a3.wrapper;
		}
		subtle2.currentComputed = currentComputed;
		subtle2.watched = Symbol("watched");
		subtle2.unwatched = Symbol("unwatched");
	})(Signal2.subtle || (Signal2.subtle = {}));
})(Signal || (Signal = {}));
/**
* equality check here is always false so that we can dirty the storage
* via setting to _anything_
*
*
* This is for a pattern where we don't *directly* use signals to back the values used in collections
* so that instanceof checks and getters and other native features "just work" without having
* to do nested proxying.
*
* (though, see deep.ts for nested / deep behavior)
*/
const createStorage = (initial = null) => new Signal.State(initial, { equals: () => false });
const ARRAY_GETTER_METHODS = new Set([
	Symbol.iterator,
	"concat",
	"entries",
	"every",
	"filter",
	"find",
	"findIndex",
	"flat",
	"flatMap",
	"forEach",
	"includes",
	"indexOf",
	"join",
	"keys",
	"lastIndexOf",
	"map",
	"reduce",
	"reduceRight",
	"slice",
	"some",
	"values"
]);
const ARRAY_WRITE_THEN_READ_METHODS = new Set([
	"fill",
	"push",
	"unshift"
]);
function convertToInt(prop) {
	if (typeof prop === "symbol") return null;
	const num = Number(prop);
	if (isNaN(num)) return null;
	return num % 1 === 0 ? num : null;
}
var SignalArray = class SignalArray {
	/**
	* Creates an array from an iterable object.
	* @param iterable An iterable object to convert to an array.
	*/
	/**
	* Creates an array from an iterable object.
	* @param iterable An iterable object to convert to an array.
	* @param mapfn A mapping function to call on every element of the array.
	* @param thisArg Value of 'this' used to invoke the mapfn.
	*/
	static from(iterable, mapfn, thisArg) {
		return mapfn ? new SignalArray(Array.from(iterable, mapfn, thisArg)) : new SignalArray(Array.from(iterable));
	}
	static of(...arr) {
		return new SignalArray(arr);
	}
	constructor(arr = []) {
		let clone = arr.slice();
		let self = this;
		let boundFns = /* @__PURE__ */ new Map();
		/**
		Flag to track whether we have *just* intercepted a call to `.push()` or
		`.unshift()`, since in those cases (and only those cases!) the `Array`
		itself checks `.length` to return from the function call.
		*/
		let nativelyAccessingLengthFromPushOrUnshift = false;
		return new Proxy(clone, {
			get(target, prop) {
				let index = convertToInt(prop);
				if (index !== null) {
					self.#readStorageFor(index);
					self.#collection.get();
					return target[index];
				}
				if (prop === "length") {
					if (nativelyAccessingLengthFromPushOrUnshift) nativelyAccessingLengthFromPushOrUnshift = false;
					else self.#collection.get();
					return target[prop];
				}
				if (ARRAY_WRITE_THEN_READ_METHODS.has(prop)) nativelyAccessingLengthFromPushOrUnshift = true;
				if (ARRAY_GETTER_METHODS.has(prop)) {
					let fn = boundFns.get(prop);
					if (fn === void 0) {
						fn = (...args) => {
							self.#collection.get();
							return target[prop](...args);
						};
						boundFns.set(prop, fn);
					}
					return fn;
				}
				return target[prop];
			},
			set(target, prop, value) {
				target[prop] = value;
				let index = convertToInt(prop);
				if (index !== null) {
					self.#dirtyStorageFor(index);
					self.#collection.set(null);
				} else if (prop === "length") self.#collection.set(null);
				return true;
			},
			getPrototypeOf() {
				return SignalArray.prototype;
			}
		});
	}
	#collection = createStorage();
	#storages = /* @__PURE__ */ new Map();
	#readStorageFor(index) {
		let storage = this.#storages.get(index);
		if (storage === void 0) {
			storage = createStorage();
			this.#storages.set(index, storage);
		}
		storage.get();
	}
	#dirtyStorageFor(index) {
		const storage = this.#storages.get(index);
		if (storage) storage.set(null);
	}
};
Object.setPrototypeOf(SignalArray.prototype, Array.prototype);
var SignalMap = class {
	collection = createStorage();
	storages = /* @__PURE__ */ new Map();
	vals;
	readStorageFor(key) {
		const { storages } = this;
		let storage = storages.get(key);
		if (storage === void 0) {
			storage = createStorage();
			storages.set(key, storage);
		}
		storage.get();
	}
	dirtyStorageFor(key) {
		const storage = this.storages.get(key);
		if (storage) storage.set(null);
	}
	constructor(existing) {
		this.vals = existing ? new Map(existing) : /* @__PURE__ */ new Map();
	}
	get(key) {
		this.readStorageFor(key);
		return this.vals.get(key);
	}
	has(key) {
		this.readStorageFor(key);
		return this.vals.has(key);
	}
	entries() {
		this.collection.get();
		return this.vals.entries();
	}
	keys() {
		this.collection.get();
		return this.vals.keys();
	}
	values() {
		this.collection.get();
		return this.vals.values();
	}
	forEach(fn) {
		this.collection.get();
		this.vals.forEach(fn);
	}
	get size() {
		this.collection.get();
		return this.vals.size;
	}
	[Symbol.iterator]() {
		this.collection.get();
		return this.vals[Symbol.iterator]();
	}
	get [Symbol.toStringTag]() {
		return this.vals[Symbol.toStringTag];
	}
	set(key, value) {
		this.dirtyStorageFor(key);
		this.collection.set(null);
		this.vals.set(key, value);
		return this;
	}
	delete(key) {
		this.dirtyStorageFor(key);
		this.collection.set(null);
		return this.vals.delete(key);
	}
	clear() {
		this.storages.forEach((s) => s.set(null));
		this.collection.set(null);
		this.vals.clear();
	}
};
Object.setPrototypeOf(SignalMap.prototype, Map.prototype);
/**
* Create a reactive Object, backed by Signals, using a Proxy.
* This allows dynamic creation and deletion of signals using the object primitive
* APIs that most folks are familiar with -- the only difference is instantiation.
* ```js
* const obj = new SignalObject({ foo: 123 });
*
* obj.foo // 123
* obj.foo = 456
* obj.foo // 456
* obj.bar = 2
* obj.bar // 2
* ```
*/
const SignalObject = class SignalObjectImpl {
	static fromEntries(entries) {
		return new SignalObjectImpl(Object.fromEntries(entries));
	}
	#storages = /* @__PURE__ */ new Map();
	#collection = createStorage();
	constructor(obj = {}) {
		let proto = Object.getPrototypeOf(obj);
		let descs = Object.getOwnPropertyDescriptors(obj);
		let clone = Object.create(proto);
		for (let prop in descs) Object.defineProperty(clone, prop, descs[prop]);
		let self = this;
		return new Proxy(clone, {
			get(target, prop, receiver) {
				self.#readStorageFor(prop);
				return Reflect.get(target, prop, receiver);
			},
			has(target, prop) {
				self.#readStorageFor(prop);
				return prop in target;
			},
			ownKeys(target) {
				self.#collection.get();
				return Reflect.ownKeys(target);
			},
			set(target, prop, value, receiver) {
				let result = Reflect.set(target, prop, value, receiver);
				self.#dirtyStorageFor(prop);
				self.#dirtyCollection();
				return result;
			},
			deleteProperty(target, prop) {
				if (prop in target) {
					delete target[prop];
					self.#dirtyStorageFor(prop);
					self.#dirtyCollection();
				}
				return true;
			},
			getPrototypeOf() {
				return SignalObjectImpl.prototype;
			}
		});
	}
	#readStorageFor(key) {
		let storage = this.#storages.get(key);
		if (storage === void 0) {
			storage = createStorage();
			this.#storages.set(key, storage);
		}
		storage.get();
	}
	#dirtyStorageFor(key) {
		const storage = this.#storages.get(key);
		if (storage) storage.set(null);
	}
	#dirtyCollection() {
		this.#collection.set(null);
	}
};
var SignalSet = class {
	collection = createStorage();
	storages = /* @__PURE__ */ new Map();
	vals;
	storageFor(key) {
		const storages = this.storages;
		let storage = storages.get(key);
		if (storage === void 0) {
			storage = createStorage();
			storages.set(key, storage);
		}
		return storage;
	}
	dirtyStorageFor(key) {
		const storage = this.storages.get(key);
		if (storage) storage.set(null);
	}
	constructor(existing) {
		this.vals = new Set(existing);
	}
	has(value) {
		this.storageFor(value).get();
		return this.vals.has(value);
	}
	entries() {
		this.collection.get();
		return this.vals.entries();
	}
	keys() {
		this.collection.get();
		return this.vals.keys();
	}
	values() {
		this.collection.get();
		return this.vals.values();
	}
	forEach(fn) {
		this.collection.get();
		this.vals.forEach(fn);
	}
	get size() {
		this.collection.get();
		return this.vals.size;
	}
	[Symbol.iterator]() {
		this.collection.get();
		return this.vals[Symbol.iterator]();
	}
	get [Symbol.toStringTag]() {
		return this.vals[Symbol.toStringTag];
	}
	add(value) {
		this.dirtyStorageFor(value);
		this.collection.set(null);
		this.vals.add(value);
		return this;
	}
	delete(value) {
		this.dirtyStorageFor(value);
		this.collection.set(null);
		return this.vals.delete(value);
	}
	clear() {
		this.storages.forEach((s) => s.set(null));
		this.collection.set(null);
		this.vals.clear();
	}
};
Object.setPrototypeOf(SignalSet.prototype, Set.prototype);
function create() {
	return new A2uiMessageProcessor({
		arrayCtor: SignalArray,
		mapCtor: SignalMap,
		objCtor: SignalObject,
		setCtor: SignalSet
	});
}
const Data = {
	createSignalA2uiMessageProcessor: create,
	A2uiMessageProcessor,
	Guards: guards_exports
};
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
const t$1 = (t) => (e, o) => {
	void 0 !== o ? o.addInitializer(() => {
		customElements.define(t, e);
	}) : customElements.define(t, e);
};
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ const o$9 = {
	attribute: !0,
	type: String,
	converter: u$3,
	reflect: !1,
	hasChanged: f$3
}, r$7 = (t = o$9, e, r) => {
	const { kind: n, metadata: i } = r;
	let s = globalThis.litPropertyMetadata.get(i);
	if (void 0 === s && globalThis.litPropertyMetadata.set(i, s = /* @__PURE__ */ new Map()), "setter" === n && ((t = Object.create(t)).wrapped = !0), s.set(r.name, t), "accessor" === n) {
		const { name: o } = r;
		return {
			set(r) {
				const n = e.get.call(this);
				e.set.call(this, r), this.requestUpdate(o, n, t, !0, r);
			},
			init(e) {
				return void 0 !== e && this.C(o, void 0, t, e), e;
			}
		};
	}
	if ("setter" === n) {
		const { name: o } = r;
		return function(r) {
			const n = this[o];
			e.call(this, r), this.requestUpdate(o, n, t, !0, r);
		};
	}
	throw Error("Unsupported decorator location: " + n);
};
function n$6(t) {
	return (e, o) => "object" == typeof o ? r$7(t, e, o) : ((t, e, o) => {
		const r = e.hasOwnProperty(o);
		return e.constructor.createProperty(o, t), r ? Object.getOwnPropertyDescriptor(e, o) : void 0;
	})(t, e, o);
}
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ function r$6(r) {
	return n$6({
		...r,
		state: !0,
		attribute: !1
	});
}
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
const e$6 = (e, t, c) => (c.configurable = !0, c.enumerable = !0, Reflect.decorate && "object" != typeof t && Object.defineProperty(e, t, c), c);
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ function e$5(e, r) {
	return (n, s, i) => {
		const o = (t) => t.renderRoot?.querySelector(e) ?? null;
		if (r) {
			const { get: e, set: r } = "object" == typeof s ? n : i ?? (() => {
				const t = Symbol();
				return {
					get() {
						return this[t];
					},
					set(e) {
						this[t] = e;
					}
				};
			})();
			return e$6(n, s, { get() {
				let t = e.call(this);
				return void 0 === t && (t = o(this), (null !== t || this.hasUpdated) && r.call(this, t)), t;
			} });
		}
		return e$6(n, s, { get() {
			return o(this);
		} });
	};
}
/**
* @license
* Copyright 2023 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ let i$2 = !1;
const s$1 = new Signal.subtle.Watcher(() => {
	i$2 || (i$2 = !0, queueMicrotask(() => {
		i$2 = !1;
		for (const t of s$1.getPending()) t.get();
		s$1.watch();
	}));
}), h$3 = Symbol("SignalWatcherBrand"), e$3 = new FinalizationRegistry((i) => {
	i.unwatch(...Signal.subtle.introspectSources(i));
}), n$4 = /* @__PURE__ */ new WeakMap();
function o$7(i) {
	return !0 === i[h$3] ? (console.warn("SignalWatcher should not be applied to the same class more than once."), i) : class extends i {
		constructor() {
			super(...arguments), this._$St = /* @__PURE__ */ new Map(), this._$So = new Signal.State(0), this._$Si = !1;
		}
		_$Sl() {
			var t, i;
			const s = [], h = [];
			this._$St.forEach((t, i) => {
				((null == t ? void 0 : t.beforeUpdate) ? s : h).push(i);
			});
			const e = null === (t = this.h) || void 0 === t ? void 0 : t.getPending().filter((t) => t !== this._$Su && !this._$St.has(t));
			s.forEach((t) => t.get()), null === (i = this._$Su) || void 0 === i || i.get(), e.forEach((t) => t.get()), h.forEach((t) => t.get());
		}
		_$Sv() {
			this.isUpdatePending || queueMicrotask(() => {
				this.isUpdatePending || this._$Sl();
			});
		}
		_$S_() {
			if (void 0 !== this.h) return;
			this._$Su = new Signal.Computed(() => {
				this._$So.get(), super.performUpdate();
			});
			const i = this.h = new Signal.subtle.Watcher(function() {
				const t = n$4.get(this);
				void 0 !== t && (!1 === t._$Si && (new Set(this.getPending()).has(t._$Su) ? t.requestUpdate() : t._$Sv()), this.watch());
			});
			n$4.set(i, this), e$3.register(this, i), i.watch(this._$Su), i.watch(...Array.from(this._$St).map(([t]) => t));
		}
		_$Sp() {
			if (void 0 === this.h) return;
			let i = !1;
			this.h.unwatch(...Signal.subtle.introspectSources(this.h).filter((t) => {
				var s;
				const h = !0 !== (null === (s = this._$St.get(t)) || void 0 === s ? void 0 : s.manualDispose);
				return h && this._$St.delete(t), i || (i = !h), h;
			})), i || (this._$Su = void 0, this.h = void 0, this._$St.clear());
		}
		updateEffect(i, s) {
			var h;
			this._$S_();
			const e = new Signal.Computed(() => {
				i();
			});
			return this.h.watch(e), this._$St.set(e, s), null !== (h = null == s ? void 0 : s.beforeUpdate) && void 0 !== h && h ? Signal.subtle.untrack(() => e.get()) : this.updateComplete.then(() => Signal.subtle.untrack(() => e.get())), () => {
				this._$St.delete(e), this.h.unwatch(e), !1 === this.isConnected && this._$Sp();
			};
		}
		performUpdate() {
			this.isUpdatePending && (this._$S_(), this._$Si = !0, this._$So.set(this._$So.get() + 1), this._$Si = !1, this._$Sl());
		}
		connectedCallback() {
			super.connectedCallback(), this.requestUpdate();
		}
		disconnectedCallback() {
			super.disconnectedCallback(), queueMicrotask(() => {
				!1 === this.isConnected && this._$Sp();
			});
		}
	};
}
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ const s = (i, t) => {
	const e = i._$AN;
	if (void 0 === e) return !1;
	for (const i of e) i._$AO?.(t, !1), s(i, t);
	return !0;
}, o$6 = (i) => {
	let t, e;
	do {
		if (void 0 === (t = i._$AM)) break;
		e = t._$AN, e.delete(i), i = t;
	} while (0 === e?.size);
}, r$3 = (i) => {
	for (let t; t = i._$AM; i = t) {
		let e = t._$AN;
		if (void 0 === e) t._$AN = e = /* @__PURE__ */ new Set();
		else if (e.has(i)) break;
		e.add(i), c(t);
	}
};
function h$2(i) {
	void 0 !== this._$AN ? (o$6(this), this._$AM = i, r$3(this)) : this._$AM = i;
}
function n$3(i, t = !1, e = 0) {
	const r = this._$AH, h = this._$AN;
	if (void 0 !== h && 0 !== h.size) if (t) if (Array.isArray(r)) for (let i = e; i < r.length; i++) s(r[i], !1), o$6(r[i]);
	else null != r && (s(r, !1), o$6(r));
	else s(this, i);
}
const c = (i) => {
	i.type == t$4.CHILD && (i._$AP ??= n$3, i._$AQ ??= h$2);
};
var f = class extends i$5 {
	constructor() {
		super(...arguments), this._$AN = void 0;
	}
	_$AT(i, t, e) {
		super._$AT(i, t, e), r$3(this), this.isConnected = i._$AU;
	}
	_$AO(i, t = !0) {
		i !== this.isConnected && (this.isConnected = i, i ? this.reconnected?.() : this.disconnected?.()), t && (s(this, i), o$6(this));
	}
	setValue(t) {
		if (r$8(this._$Ct)) this._$Ct._$AI(t, this);
		else {
			const i = [...this._$Ct._$AH];
			i[this._$Ci] = t, this._$Ct._$AI(i, this, 0);
		}
	}
	disconnected() {}
	reconnected() {}
};
/**
* @license
* Copyright 2023 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
let o$5 = !1;
const n$2 = new Signal.subtle.Watcher(async () => {
	o$5 || (o$5 = !0, queueMicrotask(() => {
		o$5 = !1;
		for (const i of n$2.getPending()) i.get();
		n$2.watch();
	}));
});
var r$2 = class extends f {
	_$S_() {
		var i, t;
		void 0 === this._$Sm && (this._$Sj = new Signal.Computed(() => {
			var i;
			const t = null === (i = this._$SW) || void 0 === i ? void 0 : i.get();
			return this.setValue(t), t;
		}), this._$Sm = null !== (t = null === (i = this._$Sk) || void 0 === i ? void 0 : i.h) && void 0 !== t ? t : n$2, this._$Sm.watch(this._$Sj), Signal.subtle.untrack(() => {
			var i;
			return null === (i = this._$Sj) || void 0 === i ? void 0 : i.get();
		}));
	}
	_$Sp() {
		void 0 !== this._$Sm && (this._$Sm.unwatch(this._$SW), this._$Sm = void 0);
	}
	render(i) {
		return Signal.subtle.untrack(() => i.get());
	}
	update(i, [t]) {
		var o, n;
		return null !== (o = this._$Sk) && void 0 !== o || (this._$Sk = null === (n = i.options) || void 0 === n ? void 0 : n.host), t !== this._$SW && void 0 !== this._$SW && this._$Sp(), this._$SW = t, this._$S_(), Signal.subtle.untrack(() => this._$SW.get());
	}
	disconnected() {
		this._$Sp();
	}
	reconnected() {
		this._$S_();
	}
};
const h$1 = e$10(r$2), m = (o) => (t, ...m) => o(t, ...m.map((o) => o instanceof Signal.State || o instanceof Signal.Computed ? h$1(o) : o));
m(b);
m(w);
Signal.State;
Signal.Computed;
/**
* @license
* Copyright 2021 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/
function* o$3(o, f) {
	if (void 0 !== o) {
		let i = 0;
		for (const t of o) yield f(t, i++);
	}
}
let pending = false;
let watcher = new Signal.subtle.Watcher(() => {
	if (!pending) {
		pending = true;
		queueMicrotask(() => {
			pending = false;
			flushPending();
		});
	}
});
function flushPending() {
	for (const signal of watcher.getPending()) signal.get();
	watcher.watch();
}
/**
* ⚠️ WARNING: Nothing unwatches ⚠️
* This will produce a memory leak.
*/
function effect(cb) {
	let c = new Signal.Computed(() => cb());
	watcher.watch(c);
	c.get();
	return () => {
		watcher.unwatch(c);
	};
}
const themeContext = n$7("A2UITheme");
const structuralStyles = r$11(structuralStyles$1);
var ComponentRegistry = class {
	constructor() {
		this.registry = /* @__PURE__ */ new Map();
	}
	register(typeName, constructor, tagName) {
		if (!/^[a-zA-Z0-9]+$/.test(typeName)) throw new Error(`[Registry] Invalid typeName '${typeName}'. Must be alphanumeric.`);
		this.registry.set(typeName, constructor);
		const actualTagName = tagName || `a2ui-custom-${typeName.toLowerCase()}`;
		const existingName = customElements.getName(constructor);
		if (existingName) {
			if (existingName !== actualTagName) throw new Error(`Component ${typeName} is already registered as ${existingName}, but requested as ${actualTagName}.`);
			return;
		}
		if (!customElements.get(actualTagName)) customElements.define(actualTagName, constructor);
	}
	get(typeName) {
		return this.registry.get(typeName);
	}
};
const componentRegistry = new ComponentRegistry();
var __runInitializers$19 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate$19 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
let Root = (() => {
	let _classDecorators = [t$1("a2ui-root")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = o$7(i$6);
	let _instanceExtraInitializers = [];
	let _surfaceId_decorators;
	let _surfaceId_initializers = [];
	let _surfaceId_extraInitializers = [];
	let _component_decorators;
	let _component_initializers = [];
	let _component_extraInitializers = [];
	let _theme_decorators;
	let _theme_initializers = [];
	let _theme_extraInitializers = [];
	let _childComponents_decorators;
	let _childComponents_initializers = [];
	let _childComponents_extraInitializers = [];
	let _processor_decorators;
	let _processor_initializers = [];
	let _processor_extraInitializers = [];
	let _dataContextPath_decorators;
	let _dataContextPath_initializers = [];
	let _dataContextPath_extraInitializers = [];
	let _enableCustomElements_decorators;
	let _enableCustomElements_initializers = [];
	let _enableCustomElements_extraInitializers = [];
	let _set_weight_decorators;
	var Root = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_surfaceId_decorators = [n$6()];
			_component_decorators = [n$6()];
			_theme_decorators = [c$1({ context: themeContext })];
			_childComponents_decorators = [n$6({ attribute: false })];
			_processor_decorators = [n$6({ attribute: false })];
			_dataContextPath_decorators = [n$6()];
			_enableCustomElements_decorators = [n$6()];
			_set_weight_decorators = [n$6()];
			__esDecorate$19(this, null, _surfaceId_decorators, {
				kind: "accessor",
				name: "surfaceId",
				static: false,
				private: false,
				access: {
					has: (obj) => "surfaceId" in obj,
					get: (obj) => obj.surfaceId,
					set: (obj, value) => {
						obj.surfaceId = value;
					}
				},
				metadata: _metadata
			}, _surfaceId_initializers, _surfaceId_extraInitializers);
			__esDecorate$19(this, null, _component_decorators, {
				kind: "accessor",
				name: "component",
				static: false,
				private: false,
				access: {
					has: (obj) => "component" in obj,
					get: (obj) => obj.component,
					set: (obj, value) => {
						obj.component = value;
					}
				},
				metadata: _metadata
			}, _component_initializers, _component_extraInitializers);
			__esDecorate$19(this, null, _theme_decorators, {
				kind: "accessor",
				name: "theme",
				static: false,
				private: false,
				access: {
					has: (obj) => "theme" in obj,
					get: (obj) => obj.theme,
					set: (obj, value) => {
						obj.theme = value;
					}
				},
				metadata: _metadata
			}, _theme_initializers, _theme_extraInitializers);
			__esDecorate$19(this, null, _childComponents_decorators, {
				kind: "accessor",
				name: "childComponents",
				static: false,
				private: false,
				access: {
					has: (obj) => "childComponents" in obj,
					get: (obj) => obj.childComponents,
					set: (obj, value) => {
						obj.childComponents = value;
					}
				},
				metadata: _metadata
			}, _childComponents_initializers, _childComponents_extraInitializers);
			__esDecorate$19(this, null, _processor_decorators, {
				kind: "accessor",
				name: "processor",
				static: false,
				private: false,
				access: {
					has: (obj) => "processor" in obj,
					get: (obj) => obj.processor,
					set: (obj, value) => {
						obj.processor = value;
					}
				},
				metadata: _metadata
			}, _processor_initializers, _processor_extraInitializers);
			__esDecorate$19(this, null, _dataContextPath_decorators, {
				kind: "accessor",
				name: "dataContextPath",
				static: false,
				private: false,
				access: {
					has: (obj) => "dataContextPath" in obj,
					get: (obj) => obj.dataContextPath,
					set: (obj, value) => {
						obj.dataContextPath = value;
					}
				},
				metadata: _metadata
			}, _dataContextPath_initializers, _dataContextPath_extraInitializers);
			__esDecorate$19(this, null, _enableCustomElements_decorators, {
				kind: "accessor",
				name: "enableCustomElements",
				static: false,
				private: false,
				access: {
					has: (obj) => "enableCustomElements" in obj,
					get: (obj) => obj.enableCustomElements,
					set: (obj, value) => {
						obj.enableCustomElements = value;
					}
				},
				metadata: _metadata
			}, _enableCustomElements_initializers, _enableCustomElements_extraInitializers);
			__esDecorate$19(this, null, _set_weight_decorators, {
				kind: "setter",
				name: "weight",
				static: false,
				private: false,
				access: {
					has: (obj) => "weight" in obj,
					set: (obj, value) => {
						obj.weight = value;
					}
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate$19(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Root = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#surfaceId_accessor_storage = (__runInitializers$19(this, _instanceExtraInitializers), __runInitializers$19(this, _surfaceId_initializers, null));
		get surfaceId() {
			return this.#surfaceId_accessor_storage;
		}
		set surfaceId(value) {
			this.#surfaceId_accessor_storage = value;
		}
		#component_accessor_storage = (__runInitializers$19(this, _surfaceId_extraInitializers), __runInitializers$19(this, _component_initializers, null));
		get component() {
			return this.#component_accessor_storage;
		}
		set component(value) {
			this.#component_accessor_storage = value;
		}
		#theme_accessor_storage = (__runInitializers$19(this, _component_extraInitializers), __runInitializers$19(this, _theme_initializers, void 0));
		get theme() {
			return this.#theme_accessor_storage;
		}
		set theme(value) {
			this.#theme_accessor_storage = value;
		}
		#childComponents_accessor_storage = (__runInitializers$19(this, _theme_extraInitializers), __runInitializers$19(this, _childComponents_initializers, null));
		get childComponents() {
			return this.#childComponents_accessor_storage;
		}
		set childComponents(value) {
			this.#childComponents_accessor_storage = value;
		}
		#processor_accessor_storage = (__runInitializers$19(this, _childComponents_extraInitializers), __runInitializers$19(this, _processor_initializers, null));
		get processor() {
			return this.#processor_accessor_storage;
		}
		set processor(value) {
			this.#processor_accessor_storage = value;
		}
		#dataContextPath_accessor_storage = (__runInitializers$19(this, _processor_extraInitializers), __runInitializers$19(this, _dataContextPath_initializers, ""));
		get dataContextPath() {
			return this.#dataContextPath_accessor_storage;
		}
		set dataContextPath(value) {
			this.#dataContextPath_accessor_storage = value;
		}
		#enableCustomElements_accessor_storage = (__runInitializers$19(this, _dataContextPath_extraInitializers), __runInitializers$19(this, _enableCustomElements_initializers, false));
		get enableCustomElements() {
			return this.#enableCustomElements_accessor_storage;
		}
		set enableCustomElements(value) {
			this.#enableCustomElements_accessor_storage = value;
		}
		set weight(weight) {
			this.#weight = weight;
			this.style.setProperty("--weight", `${weight}`);
		}
		get weight() {
			return this.#weight;
		}
		#weight = (__runInitializers$19(this, _enableCustomElements_extraInitializers), 1);
		static {
			this.styles = [structuralStyles, i$9`
      :host {
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: 80%;
      }
    `];
		}
		/**
		* Holds the cleanup function for our effect.
		* We need this to stop the effect when the component is disconnected.
		*/
		#lightDomEffectDisposer = null;
		willUpdate(changedProperties) {
			if (changedProperties.has("childComponents")) {
				if (this.#lightDomEffectDisposer) this.#lightDomEffectDisposer();
				this.#lightDomEffectDisposer = effect(() => {
					const allChildren = this.childComponents ?? null;
					D(this.renderComponentTree(allChildren), this, { host: this });
				});
			}
		}
		/**
		* Clean up the effect when the component is removed from the DOM.
		*/
		disconnectedCallback() {
			super.disconnectedCallback();
			if (this.#lightDomEffectDisposer) this.#lightDomEffectDisposer();
		}
		/**
		* Turns the SignalMap into a renderable TemplateResult for Lit.
		*/
		renderComponentTree(components) {
			if (!components) return A;
			if (!Array.isArray(components)) return A;
			return b` ${o$3(components, (component) => {
				if (this.enableCustomElements) {
					const elCtor = componentRegistry.get(component.type) || customElements.get(component.type);
					if (elCtor) {
						const node = component;
						const el = new elCtor();
						el.id = node.id;
						if (node.slotName) el.slot = node.slotName;
						el.component = node;
						el.weight = node.weight ?? "initial";
						el.processor = this.processor;
						el.surfaceId = this.surfaceId;
						el.dataContextPath = node.dataContextPath ?? "/";
						for (const [prop, val] of Object.entries(component.properties)) el[prop] = val;
						return b`${el}`;
					}
				}
				switch (component.type) {
					case "List": {
						const node = component;
						const childComponents = node.properties.children;
						return b`<a2ui-list
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .direction=${node.properties.direction ?? "vertical"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .childComponents=${childComponents}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-list>`;
					}
					case "Card": {
						const node = component;
						let childComponents = node.properties.children;
						if (!childComponents && node.properties.child) childComponents = [node.properties.child];
						return b`<a2ui-card
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .childComponents=${childComponents}
            .dataContextPath=${node.dataContextPath ?? ""}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-card>`;
					}
					case "Column": {
						const node = component;
						return b`<a2ui-column
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .childComponents=${node.properties.children ?? null}
            .dataContextPath=${node.dataContextPath ?? ""}
            .alignment=${node.properties.alignment ?? "stretch"}
            .distribution=${node.properties.distribution ?? "start"}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-column>`;
					}
					case "Row": {
						const node = component;
						return b`<a2ui-row
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .childComponents=${node.properties.children ?? null}
            .dataContextPath=${node.dataContextPath ?? ""}
            .alignment=${node.properties.alignment ?? "stretch"}
            .distribution=${node.properties.distribution ?? "start"}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-row>`;
					}
					case "Image": {
						const node = component;
						return b`<a2ui-image
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .url=${node.properties.url ?? null}
            .dataContextPath=${node.dataContextPath ?? ""}
            .usageHint=${node.properties.usageHint}
            .fit=${node.properties.fit}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-image>`;
					}
					case "Icon": {
						const node = component;
						return b`<a2ui-icon
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .name=${node.properties.name ?? null}
            .dataContextPath=${node.dataContextPath ?? ""}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-icon>`;
					}
					case "AudioPlayer": {
						const node = component;
						return b`<a2ui-audioplayer
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .url=${node.properties.url ?? null}
            .dataContextPath=${node.dataContextPath ?? ""}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-audioplayer>`;
					}
					case "Button": {
						const node = component;
						return b`<a2ui-button
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath ?? ""}
            .action=${node.properties.action}
            .childComponents=${[node.properties.child]}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-button>`;
					}
					case "Text": {
						const node = component;
						return b`<a2ui-text
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .model=${this.processor}
            .surfaceId=${this.surfaceId}
            .processor=${this.processor}
            .dataContextPath=${node.dataContextPath}
            .text=${node.properties.text}
            .usageHint=${node.properties.usageHint}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-text>`;
					}
					case "CheckBox": {
						const node = component;
						return b`<a2ui-checkbox
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath ?? ""}
            .label=${node.properties.label}
            .value=${node.properties.value}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-checkbox>`;
					}
					case "DateTimeInput": {
						const node = component;
						return b`<a2ui-datetimeinput
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath ?? ""}
            .enableDate=${node.properties.enableDate ?? true}
            .enableTime=${node.properties.enableTime ?? true}
            .outputFormat=${node.properties.outputFormat}
            .value=${node.properties.value}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-datetimeinput>`;
					}
					case "Divider": {
						const node = component;
						return b`<a2ui-divider
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath}
            .thickness=${node.properties.thickness}
            .axis=${node.properties.axis}
            .color=${node.properties.color}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-divider>`;
					}
					case "MultipleChoice": {
						const node = component;
						return b`<a2ui-multiplechoice
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath}
            .options=${node.properties.options}
            .maxAllowedSelections=${node.properties.maxAllowedSelections}
            .selections=${node.properties.selections}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-multiplechoice>`;
					}
					case "Slider": {
						const node = component;
						return b`<a2ui-slider
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath}
            .value=${node.properties.value}
            .minValue=${node.properties.minValue}
            .maxValue=${node.properties.maxValue}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-slider>`;
					}
					case "TextField": {
						const node = component;
						return b`<a2ui-textfield
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath}
            .label=${node.properties.label}
            .text=${node.properties.text}
            .type=${node.properties.type}
            .validationRegexp=${node.properties.validationRegexp}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-textfield>`;
					}
					case "Video": {
						const node = component;
						return b`<a2ui-video
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath}
            .url=${node.properties.url}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-video>`;
					}
					case "Tabs": {
						const node = component;
						const titles = [];
						const childComponents = [];
						if (node.properties.tabItems) for (const item of node.properties.tabItems) {
							titles.push(item.title);
							childComponents.push(item.child);
						}
						return b`<a2ui-tabs
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath}
            .titles=${titles}
            .childComponents=${childComponents}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-tabs>`;
					}
					case "Modal": {
						const node = component;
						const childComponents = [node.properties.entryPointChild, node.properties.contentChild];
						node.properties.entryPointChild.slotName = "entry";
						return b`<a2ui-modal
            id=${node.id}
            slot=${node.slotName ? node.slotName : A}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath}
            .childComponents=${childComponents}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-modal>`;
					}
					default: return this.renderCustomComponent(component);
				}
			})}`;
		}
		renderCustomComponent(component) {
			if (!this.enableCustomElements) return;
			const node = component;
			const elCtor = componentRegistry.get(component.type) || customElements.get(component.type);
			if (!elCtor) return b`Unknown element ${component.type}`;
			const el = new elCtor();
			el.id = node.id;
			if (node.slotName) el.slot = node.slotName;
			el.component = node;
			el.weight = node.weight ?? "initial";
			el.processor = this.processor;
			el.surfaceId = this.surfaceId;
			el.dataContextPath = node.dataContextPath ?? "/";
			for (const [prop, val] of Object.entries(component.properties)) el[prop] = val;
			return b`${el}`;
		}
		render() {
			return b`<slot></slot>`;
		}
		static {
			__runInitializers$19(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
/**
* @license
* Copyright 2018 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ const e$2 = e$10(class extends i$5 {
	constructor(t) {
		if (super(t), t.type !== t$4.ATTRIBUTE || "class" !== t.name || t.strings?.length > 2) throw Error("`classMap()` can only be used in the `class` attribute and must be the only part in the attribute.");
	}
	render(t) {
		return " " + Object.keys(t).filter((s) => t[s]).join(" ") + " ";
	}
	update(s, [i]) {
		if (void 0 === this.st) {
			this.st = /* @__PURE__ */ new Set(), void 0 !== s.strings && (this.nt = new Set(s.strings.join(" ").split(/\s/).filter((t) => "" !== t)));
			for (const t in i) i[t] && !this.nt?.has(t) && this.st.add(t);
			return this.render(i);
		}
		const r = s.element.classList;
		for (const t of this.st) t in i || (r.remove(t), this.st.delete(t));
		for (const t in i) {
			const s = !!i[t];
			s === this.st.has(t) || this.nt?.has(t) || (s ? (r.add(t), this.st.add(t)) : (r.remove(t), this.st.delete(t)));
		}
		return E;
	}
});
/**
* @license
* Copyright 2018 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ const n$1 = "important", i = " !" + n$1, o$2 = e$10(class extends i$5 {
	constructor(t) {
		if (super(t), t.type !== t$4.ATTRIBUTE || "style" !== t.name || t.strings?.length > 2) throw Error("The `styleMap` directive must be used in the `style` attribute and must be the only part in the attribute.");
	}
	render(t) {
		return Object.keys(t).reduce((e, r) => {
			const s = t[r];
			return null == s ? e : e + `${r = r.includes("-") ? r : r.replace(/(?:^(webkit|moz|ms|o)|)(?=[A-Z])/g, "-$&").toLowerCase()}:${s};`;
		}, "");
	}
	update(e, [r]) {
		const { style: s } = e.element;
		if (void 0 === this.ft) return this.ft = new Set(Object.keys(r)), this.render(r);
		for (const t of this.ft) null == r[t] && (this.ft.delete(t), t.includes("-") ? s.removeProperty(t) : s[t] = null);
		for (const t in r) {
			const e = r[t];
			if (null != e) {
				this.ft.add(t);
				const r = "string" == typeof e && e.endsWith(i);
				t.includes("-") || r ? s.setProperty(t, r ? e.slice(0, -11) : e, r ? n$1 : "") : s[t] = e;
			}
		}
		return E;
	}
});
var __esDecorate$18 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$18 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$1("a2ui-audioplayer")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _url_decorators;
	let _url_initializers = [];
	let _url_extraInitializers = [];
	var Audio = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_url_decorators = [n$6()];
			__esDecorate$18(this, null, _url_decorators, {
				kind: "accessor",
				name: "url",
				static: false,
				private: false,
				access: {
					has: (obj) => "url" in obj,
					get: (obj) => obj.url,
					set: (obj, value) => {
						obj.url = value;
					}
				},
				metadata: _metadata
			}, _url_initializers, _url_extraInitializers);
			__esDecorate$18(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Audio = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#url_accessor_storage = __runInitializers$18(this, _url_initializers, null);
		get url() {
			return this.#url_accessor_storage;
		}
		set url(value) {
			this.#url_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$9`
      * {
        box-sizing: border-box;
      }

      :host {
        display: block;
        flex: var(--weight);
        min-height: 0;
        overflow: auto;
      }

      audio {
        display: block;
        width: 100%;
      }
    `];
		}
		#renderAudio() {
			if (!this.url) return A;
			if (this.url && typeof this.url === "object") {
				if ("literalString" in this.url) return b`<audio controls src=${this.url.literalString} />`;
				else if ("literal" in this.url) return b`<audio controls src=${this.url.literal} />`;
				else if (this.url && "path" in this.url && this.url.path) {
					if (!this.processor || !this.component) return b`(no processor)`;
					const audioUrl = this.processor.getData(this.component, this.url.path, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
					if (!audioUrl) return b`Invalid audio URL`;
					if (typeof audioUrl !== "string") return b`Invalid audio URL`;
					return b`<audio controls src=${audioUrl} />`;
				}
			}
			return b`(empty)`;
		}
		render() {
			return b`<section
      class=${e$2(this.theme.components.AudioPlayer)}
      style=${this.theme.additionalStyles?.AudioPlayer ? o$2(this.theme.additionalStyles?.AudioPlayer) : A}
    >
      ${this.#renderAudio()}
    </section>`;
		}
		constructor() {
			super(...arguments);
			__runInitializers$18(this, _url_extraInitializers);
		}
		static {
			__runInitializers$18(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$17 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$17 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$1("a2ui-button")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _action_decorators;
	let _action_initializers = [];
	let _action_extraInitializers = [];
	var Button = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_action_decorators = [n$6()];
			__esDecorate$17(this, null, _action_decorators, {
				kind: "accessor",
				name: "action",
				static: false,
				private: false,
				access: {
					has: (obj) => "action" in obj,
					get: (obj) => obj.action,
					set: (obj, value) => {
						obj.action = value;
					}
				},
				metadata: _metadata
			}, _action_initializers, _action_extraInitializers);
			__esDecorate$17(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Button = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#action_accessor_storage = __runInitializers$17(this, _action_initializers, null);
		get action() {
			return this.#action_accessor_storage;
		}
		set action(value) {
			this.#action_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$9`
      :host {
        display: block;
        flex: var(--weight);
        min-height: 0;
      }
    `];
		}
		render() {
			return b`<button
      class=${e$2(this.theme.components.Button)}
      style=${this.theme.additionalStyles?.Button ? o$2(this.theme.additionalStyles?.Button) : A}
      @click=${() => {
				if (!this.action) return;
				const evt = new StateEvent({
					eventType: "a2ui.action",
					action: this.action,
					dataContextPath: this.dataContextPath,
					sourceComponentId: this.id,
					sourceComponent: this.component
				});
				this.dispatchEvent(evt);
			}}
    >
      <slot></slot>
    </button>`;
		}
		constructor() {
			super(...arguments);
			__runInitializers$17(this, _action_extraInitializers);
		}
		static {
			__runInitializers$17(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$16 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$16 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$1("a2ui-card")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	var Card = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			__esDecorate$16(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Card = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static {
			this.styles = [structuralStyles, i$9`
      * {
        box-sizing: border-box;
      }

      :host {
        display: block;
        flex: var(--weight);
        min-height: 0;
        overflow: auto;
      }

      section {
        height: 100%;
        width: 100%;
        min-height: 0;
        overflow: auto;

        ::slotted(*) {
          height: 100%;
          width: 100%;
        }
      }
    `];
		}
		render() {
			return b` <section
      class=${e$2(this.theme.components.Card)}
      style=${this.theme.additionalStyles?.Card ? o$2(this.theme.additionalStyles?.Card) : A}
    >
      <slot></slot>
    </section>`;
		}
		static {
			__runInitializers$16(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$15 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$15 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$1("a2ui-checkbox")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _value_decorators;
	let _value_initializers = [];
	let _value_extraInitializers = [];
	let _label_decorators;
	let _label_initializers = [];
	let _label_extraInitializers = [];
	var Checkbox = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_value_decorators = [n$6()];
			_label_decorators = [n$6()];
			__esDecorate$15(this, null, _value_decorators, {
				kind: "accessor",
				name: "value",
				static: false,
				private: false,
				access: {
					has: (obj) => "value" in obj,
					get: (obj) => obj.value,
					set: (obj, value) => {
						obj.value = value;
					}
				},
				metadata: _metadata
			}, _value_initializers, _value_extraInitializers);
			__esDecorate$15(this, null, _label_decorators, {
				kind: "accessor",
				name: "label",
				static: false,
				private: false,
				access: {
					has: (obj) => "label" in obj,
					get: (obj) => obj.label,
					set: (obj, value) => {
						obj.label = value;
					}
				},
				metadata: _metadata
			}, _label_initializers, _label_extraInitializers);
			__esDecorate$15(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Checkbox = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#value_accessor_storage = __runInitializers$15(this, _value_initializers, null);
		get value() {
			return this.#value_accessor_storage;
		}
		set value(value) {
			this.#value_accessor_storage = value;
		}
		#label_accessor_storage = (__runInitializers$15(this, _value_extraInitializers), __runInitializers$15(this, _label_initializers, null));
		get label() {
			return this.#label_accessor_storage;
		}
		set label(value) {
			this.#label_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$9`
      * {
        box-sizing: border-box;
      }

      :host {
        display: block;
        flex: var(--weight);
        min-height: 0;
        overflow: auto;
      }

      input {
        display: block;
        width: 100%;
      }

      .description {
        font-size: 14px;
        margin-bottom: 4px;
      }
    `];
		}
		#setBoundValue(value) {
			if (!this.value || !this.processor) return;
			if (!("path" in this.value)) return;
			if (!this.value.path) return;
			this.processor.setData(this.component, this.value.path, value, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
		}
		#renderField(value) {
			return b` <section
      class=${e$2(this.theme.components.CheckBox.container)}
      style=${this.theme.additionalStyles?.CheckBox ? o$2(this.theme.additionalStyles?.CheckBox) : A}
    >
      <input
        class=${e$2(this.theme.components.CheckBox.element)}
        autocomplete="off"
        @input=${(evt) => {
				if (!(evt.target instanceof HTMLInputElement)) return;
				this.#setBoundValue(evt.target.value);
			}}
        id="data"
        type="checkbox"
        .value=${value}
      />
      <label class=${e$2(this.theme.components.CheckBox.label)} for="data"
        >${this.label?.literalString}</label
      >
    </section>`;
		}
		render() {
			if (this.value && typeof this.value === "object") {
				if ("literalBoolean" in this.value && this.value.literalBoolean) return this.#renderField(this.value.literalBoolean);
				else if ("literal" in this.value && this.value.literal !== void 0) return this.#renderField(this.value.literal);
				else if (this.value && "path" in this.value && this.value.path) {
					if (!this.processor || !this.component) return b`(no model)`;
					const textValue = this.processor.getData(this.component, this.value.path, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
					if (textValue === null) return b`Invalid label`;
					if (typeof textValue !== "boolean") return b`Invalid label`;
					return this.#renderField(textValue);
				}
			}
			return A;
		}
		constructor() {
			super(...arguments);
			__runInitializers$15(this, _label_extraInitializers);
		}
		static {
			__runInitializers$15(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$14 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$14 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$1("a2ui-column")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _alignment_decorators;
	let _alignment_initializers = [];
	let _alignment_extraInitializers = [];
	let _distribution_decorators;
	let _distribution_initializers = [];
	let _distribution_extraInitializers = [];
	var Column = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_alignment_decorators = [n$6({
				reflect: true,
				type: String
			})];
			_distribution_decorators = [n$6({
				reflect: true,
				type: String
			})];
			__esDecorate$14(this, null, _alignment_decorators, {
				kind: "accessor",
				name: "alignment",
				static: false,
				private: false,
				access: {
					has: (obj) => "alignment" in obj,
					get: (obj) => obj.alignment,
					set: (obj, value) => {
						obj.alignment = value;
					}
				},
				metadata: _metadata
			}, _alignment_initializers, _alignment_extraInitializers);
			__esDecorate$14(this, null, _distribution_decorators, {
				kind: "accessor",
				name: "distribution",
				static: false,
				private: false,
				access: {
					has: (obj) => "distribution" in obj,
					get: (obj) => obj.distribution,
					set: (obj, value) => {
						obj.distribution = value;
					}
				},
				metadata: _metadata
			}, _distribution_initializers, _distribution_extraInitializers);
			__esDecorate$14(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Column = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#alignment_accessor_storage = __runInitializers$14(this, _alignment_initializers, "stretch");
		get alignment() {
			return this.#alignment_accessor_storage;
		}
		set alignment(value) {
			this.#alignment_accessor_storage = value;
		}
		#distribution_accessor_storage = (__runInitializers$14(this, _alignment_extraInitializers), __runInitializers$14(this, _distribution_initializers, "start"));
		get distribution() {
			return this.#distribution_accessor_storage;
		}
		set distribution(value) {
			this.#distribution_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$9`
      * {
        box-sizing: border-box;
      }

      :host {
        display: flex;
        flex: var(--weight);
      }

      section {
        display: flex;
        flex-direction: column;
        min-width: 100%;
        height: 100%;
      }

      :host([alignment="start"]) section {
        align-items: start;
      }

      :host([alignment="center"]) section {
        align-items: center;
      }

      :host([alignment="end"]) section {
        align-items: end;
      }

      :host([alignment="stretch"]) section {
        align-items: stretch;
      }

      :host([distribution="start"]) section {
        justify-content: start;
      }

      :host([distribution="center"]) section {
        justify-content: center;
      }

      :host([distribution="end"]) section {
        justify-content: end;
      }

      :host([distribution="spaceBetween"]) section {
        justify-content: space-between;
      }

      :host([distribution="spaceAround"]) section {
        justify-content: space-around;
      }

      :host([distribution="spaceEvenly"]) section {
        justify-content: space-evenly;
      }
    `];
		}
		render() {
			return b`<section
      class=${e$2(this.theme.components.Column)}
      style=${this.theme.additionalStyles?.Column ? o$2(this.theme.additionalStyles?.Column) : A}
    >
      <slot></slot>
    </section>`;
		}
		constructor() {
			super(...arguments);
			__runInitializers$14(this, _distribution_extraInitializers);
		}
		static {
			__runInitializers$14(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$13 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$13 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$1("a2ui-datetimeinput")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _value_decorators;
	let _value_initializers = [];
	let _value_extraInitializers = [];
	let _label_decorators;
	let _label_initializers = [];
	let _label_extraInitializers = [];
	let _enableDate_decorators;
	let _enableDate_initializers = [];
	let _enableDate_extraInitializers = [];
	let _enableTime_decorators;
	let _enableTime_initializers = [];
	let _enableTime_extraInitializers = [];
	var DateTimeInput = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_value_decorators = [n$6()];
			_label_decorators = [n$6()];
			_enableDate_decorators = [n$6({
				reflect: false,
				type: Boolean
			})];
			_enableTime_decorators = [n$6({
				reflect: false,
				type: Boolean
			})];
			__esDecorate$13(this, null, _value_decorators, {
				kind: "accessor",
				name: "value",
				static: false,
				private: false,
				access: {
					has: (obj) => "value" in obj,
					get: (obj) => obj.value,
					set: (obj, value) => {
						obj.value = value;
					}
				},
				metadata: _metadata
			}, _value_initializers, _value_extraInitializers);
			__esDecorate$13(this, null, _label_decorators, {
				kind: "accessor",
				name: "label",
				static: false,
				private: false,
				access: {
					has: (obj) => "label" in obj,
					get: (obj) => obj.label,
					set: (obj, value) => {
						obj.label = value;
					}
				},
				metadata: _metadata
			}, _label_initializers, _label_extraInitializers);
			__esDecorate$13(this, null, _enableDate_decorators, {
				kind: "accessor",
				name: "enableDate",
				static: false,
				private: false,
				access: {
					has: (obj) => "enableDate" in obj,
					get: (obj) => obj.enableDate,
					set: (obj, value) => {
						obj.enableDate = value;
					}
				},
				metadata: _metadata
			}, _enableDate_initializers, _enableDate_extraInitializers);
			__esDecorate$13(this, null, _enableTime_decorators, {
				kind: "accessor",
				name: "enableTime",
				static: false,
				private: false,
				access: {
					has: (obj) => "enableTime" in obj,
					get: (obj) => obj.enableTime,
					set: (obj, value) => {
						obj.enableTime = value;
					}
				},
				metadata: _metadata
			}, _enableTime_initializers, _enableTime_extraInitializers);
			__esDecorate$13(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			DateTimeInput = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#value_accessor_storage = __runInitializers$13(this, _value_initializers, null);
		get value() {
			return this.#value_accessor_storage;
		}
		set value(value) {
			this.#value_accessor_storage = value;
		}
		#label_accessor_storage = (__runInitializers$13(this, _value_extraInitializers), __runInitializers$13(this, _label_initializers, null));
		get label() {
			return this.#label_accessor_storage;
		}
		set label(value) {
			this.#label_accessor_storage = value;
		}
		#enableDate_accessor_storage = (__runInitializers$13(this, _label_extraInitializers), __runInitializers$13(this, _enableDate_initializers, true));
		get enableDate() {
			return this.#enableDate_accessor_storage;
		}
		set enableDate(value) {
			this.#enableDate_accessor_storage = value;
		}
		#enableTime_accessor_storage = (__runInitializers$13(this, _enableDate_extraInitializers), __runInitializers$13(this, _enableTime_initializers, true));
		get enableTime() {
			return this.#enableTime_accessor_storage;
		}
		set enableTime(value) {
			this.#enableTime_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$9`
      * {
        box-sizing: border-box;
      }

      :host {
        display: block;
        flex: var(--weight);
        min-height: 0;
        overflow: auto;
      }

      input {
        display: block;
        border-radius: 8px;
        padding: 8px;
        border: 1px solid #ccc;
        width: 100%;
      }
    `];
		}
		#setBoundValue(value) {
			if (!this.value || !this.processor) return;
			if (!("path" in this.value)) return;
			if (!this.value.path) return;
			this.processor.setData(this.component, this.value.path, value, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
		}
		#renderField(value) {
			return b`<section
      class=${e$2(this.theme.components.DateTimeInput.container)}
    >
      <label
        for="data"
        class=${e$2(this.theme.components.DateTimeInput.label)}
        >${this.#getPlaceholderText()}</label
      >
      <input
        autocomplete="off"
        class=${e$2(this.theme.components.DateTimeInput.element)}
        style=${this.theme.additionalStyles?.DateTimeInput ? o$2(this.theme.additionalStyles?.DateTimeInput) : A}
        @input=${(evt) => {
				if (!(evt.target instanceof HTMLInputElement)) return;
				this.#setBoundValue(evt.target.value);
			}}
        id="data"
        name="data"
        .value=${this.#formatInputValue(value)}
        .placeholder=${this.#getPlaceholderText()}
        .type=${this.#getInputType()}
      />
    </section>`;
		}
		#getInputType() {
			if (this.enableDate && this.enableTime) return "datetime-local";
			else if (this.enableDate) return "date";
			else if (this.enableTime) return "time";
			return "datetime-local";
		}
		#formatInputValue(value) {
			const inputType = this.#getInputType();
			const date = value ? new Date(value) : null;
			if (!date || isNaN(date.getTime())) return "";
			const year = this.#padNumber(date.getFullYear());
			const month = this.#padNumber(date.getMonth());
			const day = this.#padNumber(date.getDate());
			const hours = this.#padNumber(date.getHours());
			const minutes = this.#padNumber(date.getMinutes());
			if (inputType === "date") return `${year}-${month}-${day}`;
			else if (inputType === "time") return `${hours}:${minutes}`;
			return `${year}-${month}-${day}T${hours}:${minutes}`;
		}
		#padNumber(value) {
			return value.toString().padStart(2, "0");
		}
		#getPlaceholderText() {
			const inputType = this.#getInputType();
			if (inputType === "date") return "Date";
			else if (inputType === "time") return "Time";
			return "Date & Time";
		}
		render() {
			if (this.value && typeof this.value === "object") {
				if ("literalString" in this.value && this.value.literalString) return this.#renderField(this.value.literalString);
				else if ("literal" in this.value && this.value.literal !== void 0) return this.#renderField(this.value.literal);
				else if (this.value && "path" in this.value && this.value.path) {
					if (!this.processor || !this.component) return b`(no model)`;
					const textValue = this.processor.getData(this.component, this.value.path, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
					if (typeof textValue !== "string") return b`(invalid)`;
					return this.#renderField(textValue);
				}
			}
			return A;
		}
		constructor() {
			super(...arguments);
			__runInitializers$13(this, _enableTime_extraInitializers);
		}
		static {
			__runInitializers$13(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$12 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$12 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$1("a2ui-divider")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	var Divider = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			__esDecorate$12(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Divider = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static {
			this.styles = [structuralStyles, i$9`
      :host {
        display: block;
        min-height: 0;
        overflow: auto;
      }

      hr {
        height: 1px;
        background: #ccc;
        border: none;
      }
    `];
		}
		render() {
			return b`<hr
      class=${e$2(this.theme.components.Divider)}
      style=${this.theme.additionalStyles?.Divider ? o$2(this.theme.additionalStyles?.Divider) : A}
    />`;
		}
		static {
			__runInitializers$12(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$11 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$11 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$1("a2ui-icon")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _name_decorators;
	let _name_initializers = [];
	let _name_extraInitializers = [];
	var Icon = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_name_decorators = [n$6()];
			__esDecorate$11(this, null, _name_decorators, {
				kind: "accessor",
				name: "name",
				static: false,
				private: false,
				access: {
					has: (obj) => "name" in obj,
					get: (obj) => obj.name,
					set: (obj, value) => {
						obj.name = value;
					}
				},
				metadata: _metadata
			}, _name_initializers, _name_extraInitializers);
			__esDecorate$11(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Icon = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#name_accessor_storage = __runInitializers$11(this, _name_initializers, null);
		get name() {
			return this.#name_accessor_storage;
		}
		set name(value) {
			this.#name_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$9`
      * {
        box-sizing: border-box;
      }

      :host {
        display: block;
        flex: var(--weight);
        min-height: 0;
        overflow: auto;
      }
    `];
		}
		#renderIcon() {
			if (!this.name) return A;
			const render = (url) => {
				url = url.replace(/([A-Z])/gm, "_$1").toLocaleLowerCase();
				return b`<span class="g-icon">${url}</span>`;
			};
			if (this.name && typeof this.name === "object") {
				if ("literalString" in this.name) return render(this.name.literalString ?? "");
				else if ("literal" in this.name) return render(this.name.literal ?? "");
				else if (this.name && "path" in this.name && this.name.path) {
					if (!this.processor || !this.component) return b`(no model)`;
					const iconName = this.processor.getData(this.component, this.name.path, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
					if (!iconName) return b`Invalid icon name`;
					if (typeof iconName !== "string") return b`Invalid icon name`;
					return render(iconName);
				}
			}
			return b`(empty)`;
		}
		render() {
			return b`<section
      class=${e$2(this.theme.components.Icon)}
      style=${this.theme.additionalStyles?.Icon ? o$2(this.theme.additionalStyles?.Icon) : A}
    >
      ${this.#renderIcon()}
    </section>`;
		}
		constructor() {
			super(...arguments);
			__runInitializers$11(this, _name_extraInitializers);
		}
		static {
			__runInitializers$11(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$10 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$10 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$1("a2ui-image")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _url_decorators;
	let _url_initializers = [];
	let _url_extraInitializers = [];
	let _usageHint_decorators;
	let _usageHint_initializers = [];
	let _usageHint_extraInitializers = [];
	let _fit_decorators;
	let _fit_initializers = [];
	let _fit_extraInitializers = [];
	var Image = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_url_decorators = [n$6()];
			_usageHint_decorators = [n$6()];
			_fit_decorators = [n$6()];
			__esDecorate$10(this, null, _url_decorators, {
				kind: "accessor",
				name: "url",
				static: false,
				private: false,
				access: {
					has: (obj) => "url" in obj,
					get: (obj) => obj.url,
					set: (obj, value) => {
						obj.url = value;
					}
				},
				metadata: _metadata
			}, _url_initializers, _url_extraInitializers);
			__esDecorate$10(this, null, _usageHint_decorators, {
				kind: "accessor",
				name: "usageHint",
				static: false,
				private: false,
				access: {
					has: (obj) => "usageHint" in obj,
					get: (obj) => obj.usageHint,
					set: (obj, value) => {
						obj.usageHint = value;
					}
				},
				metadata: _metadata
			}, _usageHint_initializers, _usageHint_extraInitializers);
			__esDecorate$10(this, null, _fit_decorators, {
				kind: "accessor",
				name: "fit",
				static: false,
				private: false,
				access: {
					has: (obj) => "fit" in obj,
					get: (obj) => obj.fit,
					set: (obj, value) => {
						obj.fit = value;
					}
				},
				metadata: _metadata
			}, _fit_initializers, _fit_extraInitializers);
			__esDecorate$10(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Image = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#url_accessor_storage = __runInitializers$10(this, _url_initializers, null);
		get url() {
			return this.#url_accessor_storage;
		}
		set url(value) {
			this.#url_accessor_storage = value;
		}
		#usageHint_accessor_storage = (__runInitializers$10(this, _url_extraInitializers), __runInitializers$10(this, _usageHint_initializers, null));
		get usageHint() {
			return this.#usageHint_accessor_storage;
		}
		set usageHint(value) {
			this.#usageHint_accessor_storage = value;
		}
		#fit_accessor_storage = (__runInitializers$10(this, _usageHint_extraInitializers), __runInitializers$10(this, _fit_initializers, null));
		get fit() {
			return this.#fit_accessor_storage;
		}
		set fit(value) {
			this.#fit_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$9`
      * {
        box-sizing: border-box;
      }

      :host {
        display: block;
        flex: var(--weight);
        min-height: 0;
        overflow: auto;
      }

      img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: var(--object-fit, fill);
      }
    `];
		}
		#renderImage() {
			if (!this.url) return A;
			const render = (url) => {
				return b`<img src=${url} />`;
			};
			if (this.url && typeof this.url === "object") {
				if ("literalString" in this.url) return render(this.url.literalString ?? "");
				else if ("literal" in this.url) return render(this.url.literal ?? "");
				else if (this.url && "path" in this.url && this.url.path) {
					if (!this.processor || !this.component) return b`(no model)`;
					const imageUrl = this.processor.getData(this.component, this.url.path, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
					if (!imageUrl) return b`Invalid image URL`;
					if (typeof imageUrl !== "string") return b`Invalid image URL`;
					return render(imageUrl);
				}
			}
			return b`(empty)`;
		}
		render() {
			return b`<section
      class=${e$2(merge(this.theme.components.Image.all, this.usageHint ? this.theme.components.Image[this.usageHint] : {}))}
      style=${o$2({
				...this.theme.additionalStyles?.Image ?? {},
				"--object-fit": this.fit ?? "fill"
			})}
    >
      ${this.#renderImage()}
    </section>`;
		}
		constructor() {
			super(...arguments);
			__runInitializers$10(this, _fit_extraInitializers);
		}
		static {
			__runInitializers$10(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$9 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$9 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$1("a2ui-list")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _direction_decorators;
	let _direction_initializers = [];
	let _direction_extraInitializers = [];
	var List = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_direction_decorators = [n$6({
				reflect: true,
				type: String
			})];
			__esDecorate$9(this, null, _direction_decorators, {
				kind: "accessor",
				name: "direction",
				static: false,
				private: false,
				access: {
					has: (obj) => "direction" in obj,
					get: (obj) => obj.direction,
					set: (obj, value) => {
						obj.direction = value;
					}
				},
				metadata: _metadata
			}, _direction_initializers, _direction_extraInitializers);
			__esDecorate$9(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			List = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#direction_accessor_storage = __runInitializers$9(this, _direction_initializers, "vertical");
		get direction() {
			return this.#direction_accessor_storage;
		}
		set direction(value) {
			this.#direction_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$9`
      * {
        box-sizing: border-box;
      }

      :host {
        display: block;
        flex: var(--weight);
        min-height: 0;
        overflow: auto;
      }

      :host([direction="vertical"]) section {
        display: grid;
      }

      :host([direction="horizontal"]) section {
        display: flex;
        max-width: 100%;
        overflow-x: scroll;
        overflow-y: hidden;
        scrollbar-width: none;

        > ::slotted(*) {
          flex: 1 0 fit-content;
          max-width: min(80%, 400px);
        }
      }
    `];
		}
		render() {
			return b`<section
      class=${e$2(this.theme.components.List)}
      style=${this.theme.additionalStyles?.List ? o$2(this.theme.additionalStyles?.List) : A}
    >
      <slot></slot>
    </section>`;
		}
		constructor() {
			super(...arguments);
			__runInitializers$9(this, _direction_extraInitializers);
		}
		static {
			__runInitializers$9(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
function extractStringValue(val, component, processor, surfaceId) {
	if (val !== null && typeof val === "object") {
		if ("literalString" in val) return val.literalString ?? "";
		else if ("literal" in val && val.literal !== void 0) return val.literal ?? "";
		else if (val && "path" in val && val.path) {
			if (!processor || !component) return "(no model)";
			const textValue = processor.getData(component, val.path, surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
			if (textValue === null || typeof textValue !== "string") return "";
			return textValue;
		}
	}
	return "";
}
function extractNumberValue(val, component, processor, surfaceId) {
	if (val !== null && typeof val === "object") {
		if ("literalNumber" in val) return val.literalNumber ?? 0;
		else if ("literal" in val && val.literal !== void 0) return val.literal ?? 0;
		else if (val && "path" in val && val.path) {
			if (!processor || !component) return -1;
			let numberValue = processor.getData(component, val.path, surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
			if (typeof numberValue === "string") {
				numberValue = Number.parseInt(numberValue, 10);
				if (Number.isNaN(numberValue)) numberValue = null;
			}
			if (numberValue === null || typeof numberValue !== "number") return -1;
			return numberValue;
		}
	}
	return 0;
}
var __esDecorate$8 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$8 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$1("a2ui-multiplechoice")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _description_decorators;
	let _description_initializers = [];
	let _description_extraInitializers = [];
	let _options_decorators;
	let _options_initializers = [];
	let _options_extraInitializers = [];
	let _selections_decorators;
	let _selections_initializers = [];
	let _selections_extraInitializers = [];
	var MultipleChoice = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_description_decorators = [n$6()];
			_options_decorators = [n$6()];
			_selections_decorators = [n$6()];
			__esDecorate$8(this, null, _description_decorators, {
				kind: "accessor",
				name: "description",
				static: false,
				private: false,
				access: {
					has: (obj) => "description" in obj,
					get: (obj) => obj.description,
					set: (obj, value) => {
						obj.description = value;
					}
				},
				metadata: _metadata
			}, _description_initializers, _description_extraInitializers);
			__esDecorate$8(this, null, _options_decorators, {
				kind: "accessor",
				name: "options",
				static: false,
				private: false,
				access: {
					has: (obj) => "options" in obj,
					get: (obj) => obj.options,
					set: (obj, value) => {
						obj.options = value;
					}
				},
				metadata: _metadata
			}, _options_initializers, _options_extraInitializers);
			__esDecorate$8(this, null, _selections_decorators, {
				kind: "accessor",
				name: "selections",
				static: false,
				private: false,
				access: {
					has: (obj) => "selections" in obj,
					get: (obj) => obj.selections,
					set: (obj, value) => {
						obj.selections = value;
					}
				},
				metadata: _metadata
			}, _selections_initializers, _selections_extraInitializers);
			__esDecorate$8(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			MultipleChoice = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#description_accessor_storage = __runInitializers$8(this, _description_initializers, null);
		get description() {
			return this.#description_accessor_storage;
		}
		set description(value) {
			this.#description_accessor_storage = value;
		}
		#options_accessor_storage = (__runInitializers$8(this, _description_extraInitializers), __runInitializers$8(this, _options_initializers, []));
		get options() {
			return this.#options_accessor_storage;
		}
		set options(value) {
			this.#options_accessor_storage = value;
		}
		#selections_accessor_storage = (__runInitializers$8(this, _options_extraInitializers), __runInitializers$8(this, _selections_initializers, []));
		get selections() {
			return this.#selections_accessor_storage;
		}
		set selections(value) {
			this.#selections_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$9`
      * {
        box-sizing: border-box;
      }

      :host {
        display: block;
        flex: var(--weight);
        min-height: 0;
        overflow: auto;
      }

      select {
        width: 100%;
      }

      .description {
      }
    `];
		}
		#setBoundValue(value) {
			console.log(value);
			if (!this.selections || !this.processor) return;
			if (!("path" in this.selections)) return;
			if (!this.selections.path) return;
			this.processor.setData(this.component, this.selections.path, value, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
		}
		willUpdate(changedProperties) {
			if (!changedProperties.has("options")) return;
			if (!this.processor || !this.component || Array.isArray(this.selections)) return;
			this.selections;
			const selectionValue = this.processor.getData(this.component, this.selections.path, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
			if (!Array.isArray(selectionValue)) return;
			this.#setBoundValue(selectionValue);
		}
		render() {
			return b`<section class=${e$2(this.theme.components.MultipleChoice.container)}>
      <label class=${e$2(this.theme.components.MultipleChoice.label)} for="data">${this.description ?? "Select an item"}</div>
      <select
        name="data"
        id="data"
        class=${e$2(this.theme.components.MultipleChoice.element)}
        style=${this.theme.additionalStyles?.MultipleChoice ? o$2(this.theme.additionalStyles?.MultipleChoice) : A}
        @change=${(evt) => {
				if (!(evt.target instanceof HTMLSelectElement)) return;
				this.#setBoundValue([evt.target.value]);
			}}
      >
        ${this.options.map((option) => {
				const label = extractStringValue(option.label, this.component, this.processor, this.surfaceId);
				return b`<option ${option.value}>${label}</option>`;
			})}
      </select>
    </section>`;
		}
		constructor() {
			super(...arguments);
			__runInitializers$8(this, _selections_extraInitializers);
		}
		static {
			__runInitializers$8(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
const o$1 = /* @__PURE__ */ new WeakMap(), n = e$10(class extends f {
	render(i) {
		return A;
	}
	update(i, [s]) {
		const e = s !== this.G;
		return e && void 0 !== this.G && this.rt(void 0), (e || this.lt !== this.ct) && (this.G = s, this.ht = i.options?.host, this.rt(this.ct = i.element)), A;
	}
	rt(t) {
		if (this.isConnected || (t = void 0), "function" == typeof this.G) {
			const i = this.ht ?? globalThis;
			let s = o$1.get(i);
			void 0 === s && (s = /* @__PURE__ */ new WeakMap(), o$1.set(i, s)), void 0 !== s.get(this.G) && this.G.call(this.ht, void 0), s.set(this.G, t), void 0 !== t && this.G.call(this.ht, t);
		} else this.G.value = t;
	}
	get lt() {
		return "function" == typeof this.G ? o$1.get(this.ht ?? globalThis)?.get(this.G) : this.G?.value;
	}
	disconnected() {
		this.lt === this.ct && this.rt(void 0);
	}
	reconnected() {
		this.rt(this.ct);
	}
});
var __esDecorate$7 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$7 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __setFunctionName = function(f, name, prefix) {
	if (typeof name === "symbol") name = name.description ? "[".concat(name.description, "]") : "";
	return Object.defineProperty(f, "name", {
		configurable: true,
		value: prefix ? "".concat(prefix, " ", name) : name
	});
};
(() => {
	let _classDecorators = [t$1("a2ui-modal")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _private_showModal_decorators;
	let _private_showModal_initializers = [];
	let _private_showModal_extraInitializers = [];
	let _private_showModal_descriptor;
	let _private_modalRef_decorators;
	let _private_modalRef_initializers = [];
	let _private_modalRef_extraInitializers = [];
	let _private_modalRef_descriptor;
	var Modal = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_private_showModal_decorators = [r$6()];
			_private_modalRef_decorators = [e$5("dialog")];
			__esDecorate$7(this, _private_showModal_descriptor = {
				get: __setFunctionName(function() {
					return this.#showModal_accessor_storage;
				}, "#showModal", "get"),
				set: __setFunctionName(function(value) {
					this.#showModal_accessor_storage = value;
				}, "#showModal", "set")
			}, _private_showModal_decorators, {
				kind: "accessor",
				name: "#showModal",
				static: false,
				private: true,
				access: {
					has: (obj) => #showModal in obj,
					get: (obj) => obj.#showModal,
					set: (obj, value) => {
						obj.#showModal = value;
					}
				},
				metadata: _metadata
			}, _private_showModal_initializers, _private_showModal_extraInitializers);
			__esDecorate$7(this, _private_modalRef_descriptor = {
				get: __setFunctionName(function() {
					return this.#modalRef_accessor_storage;
				}, "#modalRef", "get"),
				set: __setFunctionName(function(value) {
					this.#modalRef_accessor_storage = value;
				}, "#modalRef", "set")
			}, _private_modalRef_decorators, {
				kind: "accessor",
				name: "#modalRef",
				static: false,
				private: true,
				access: {
					has: (obj) => #modalRef in obj,
					get: (obj) => obj.#modalRef,
					set: (obj, value) => {
						obj.#modalRef = value;
					}
				},
				metadata: _metadata
			}, _private_modalRef_initializers, _private_modalRef_extraInitializers);
			__esDecorate$7(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Modal = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static {
			this.styles = [structuralStyles, i$9`
      * {
        box-sizing: border-box;
      }

      dialog {
        padding: 0 0 0 0;
        border: none;
        background: none;

        & section {
          & #controls {
            display: flex;
            justify-content: end;
            margin-bottom: 4px;

            & button {
              padding: 0;
              background: none;
              width: 20px;
              height: 20px;
              pointer: cursor;
              border: none;
              cursor: pointer;
            }
          }
        }
      }
    `];
		}
		#showModal_accessor_storage = __runInitializers$7(this, _private_showModal_initializers, false);
		get #showModal() {
			return _private_showModal_descriptor.get.call(this);
		}
		set #showModal(value) {
			return _private_showModal_descriptor.set.call(this, value);
		}
		#modalRef_accessor_storage = (__runInitializers$7(this, _private_showModal_extraInitializers), __runInitializers$7(this, _private_modalRef_initializers, null));
		get #modalRef() {
			return _private_modalRef_descriptor.get.call(this);
		}
		set #modalRef(value) {
			return _private_modalRef_descriptor.set.call(this, value);
		}
		#closeModal() {
			if (!this.#modalRef) return;
			if (this.#modalRef.open) this.#modalRef.close();
			this.#showModal = false;
		}
		render() {
			if (!this.#showModal) return b`<section
        @click=${() => {
				this.#showModal = true;
			}}
      >
        <slot name="entry"></slot>
      </section>`;
			return b`<dialog
      class=${e$2(this.theme.components.Modal.backdrop)}
      @click=${(evt) => {
				const [top] = evt.composedPath();
				if (!(top instanceof HTMLDialogElement)) return;
				this.#closeModal();
			}}
      ${n((el) => {
				const showModalIfNeeded = () => {
					if (!(el && el instanceof HTMLDialogElement) || el.open) return;
					el.showModal();
				};
				requestAnimationFrame(showModalIfNeeded);
			})}
    >
      <section
        class=${e$2(this.theme.components.Modal.element)}
        style=${this.theme.additionalStyles?.Modal ? o$2(this.theme.additionalStyles?.Modal) : A}
      >
        <div id="controls">
          <button
            @click=${() => {
				this.#closeModal();
			}}
          >
            <span class="g-icon">close</span>
          </button>
        </div>
        <slot></slot>
      </section>
    </dialog>`;
		}
		constructor() {
			super(...arguments);
			__runInitializers$7(this, _private_modalRef_extraInitializers);
		}
		static {
			__runInitializers$7(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$6 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$6 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$1("a2ui-row")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _alignment_decorators;
	let _alignment_initializers = [];
	let _alignment_extraInitializers = [];
	let _distribution_decorators;
	let _distribution_initializers = [];
	let _distribution_extraInitializers = [];
	var Row = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_alignment_decorators = [n$6({
				reflect: true,
				type: String
			})];
			_distribution_decorators = [n$6({
				reflect: true,
				type: String
			})];
			__esDecorate$6(this, null, _alignment_decorators, {
				kind: "accessor",
				name: "alignment",
				static: false,
				private: false,
				access: {
					has: (obj) => "alignment" in obj,
					get: (obj) => obj.alignment,
					set: (obj, value) => {
						obj.alignment = value;
					}
				},
				metadata: _metadata
			}, _alignment_initializers, _alignment_extraInitializers);
			__esDecorate$6(this, null, _distribution_decorators, {
				kind: "accessor",
				name: "distribution",
				static: false,
				private: false,
				access: {
					has: (obj) => "distribution" in obj,
					get: (obj) => obj.distribution,
					set: (obj, value) => {
						obj.distribution = value;
					}
				},
				metadata: _metadata
			}, _distribution_initializers, _distribution_extraInitializers);
			__esDecorate$6(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Row = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#alignment_accessor_storage = __runInitializers$6(this, _alignment_initializers, "stretch");
		get alignment() {
			return this.#alignment_accessor_storage;
		}
		set alignment(value) {
			this.#alignment_accessor_storage = value;
		}
		#distribution_accessor_storage = (__runInitializers$6(this, _alignment_extraInitializers), __runInitializers$6(this, _distribution_initializers, "start"));
		get distribution() {
			return this.#distribution_accessor_storage;
		}
		set distribution(value) {
			this.#distribution_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$9`
      * {
        box-sizing: border-box;
      }

      :host {
        display: flex;
        flex: var(--weight);
      }

      section {
        display: flex;
        flex-direction: row;
        width: 100%;
        min-height: 100%;
      }

      :host([alignment="start"]) section {
        align-items: start;
      }

      :host([alignment="center"]) section {
        align-items: center;
      }

      :host([alignment="end"]) section {
        align-items: end;
      }

      :host([alignment="stretch"]) section {
        align-items: stretch;
      }

      :host([distribution="start"]) section {
        justify-content: start;
      }

      :host([distribution="center"]) section {
        justify-content: center;
      }

      :host([distribution="end"]) section {
        justify-content: end;
      }

      :host([distribution="spaceBetween"]) section {
        justify-content: space-between;
      }

      :host([distribution="spaceAround"]) section {
        justify-content: space-around;
      }

      :host([distribution="spaceEvenly"]) section {
        justify-content: space-evenly;
      }
    `];
		}
		render() {
			return b`<section
      class=${e$2(this.theme.components.Row)}
      style=${this.theme.additionalStyles?.Row ? o$2(this.theme.additionalStyles?.Row) : A}
    >
      <slot></slot>
    </section>`;
		}
		constructor() {
			super(...arguments);
			__runInitializers$6(this, _distribution_extraInitializers);
		}
		static {
			__runInitializers$6(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$5 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$5 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$1("a2ui-slider")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _value_decorators;
	let _value_initializers = [];
	let _value_extraInitializers = [];
	let _minValue_decorators;
	let _minValue_initializers = [];
	let _minValue_extraInitializers = [];
	let _maxValue_decorators;
	let _maxValue_initializers = [];
	let _maxValue_extraInitializers = [];
	let _label_decorators;
	let _label_initializers = [];
	let _label_extraInitializers = [];
	let _inputType_decorators;
	let _inputType_initializers = [];
	let _inputType_extraInitializers = [];
	var Slider = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_value_decorators = [n$6()];
			_minValue_decorators = [n$6()];
			_maxValue_decorators = [n$6()];
			_label_decorators = [n$6()];
			_inputType_decorators = [n$6()];
			__esDecorate$5(this, null, _value_decorators, {
				kind: "accessor",
				name: "value",
				static: false,
				private: false,
				access: {
					has: (obj) => "value" in obj,
					get: (obj) => obj.value,
					set: (obj, value) => {
						obj.value = value;
					}
				},
				metadata: _metadata
			}, _value_initializers, _value_extraInitializers);
			__esDecorate$5(this, null, _minValue_decorators, {
				kind: "accessor",
				name: "minValue",
				static: false,
				private: false,
				access: {
					has: (obj) => "minValue" in obj,
					get: (obj) => obj.minValue,
					set: (obj, value) => {
						obj.minValue = value;
					}
				},
				metadata: _metadata
			}, _minValue_initializers, _minValue_extraInitializers);
			__esDecorate$5(this, null, _maxValue_decorators, {
				kind: "accessor",
				name: "maxValue",
				static: false,
				private: false,
				access: {
					has: (obj) => "maxValue" in obj,
					get: (obj) => obj.maxValue,
					set: (obj, value) => {
						obj.maxValue = value;
					}
				},
				metadata: _metadata
			}, _maxValue_initializers, _maxValue_extraInitializers);
			__esDecorate$5(this, null, _label_decorators, {
				kind: "accessor",
				name: "label",
				static: false,
				private: false,
				access: {
					has: (obj) => "label" in obj,
					get: (obj) => obj.label,
					set: (obj, value) => {
						obj.label = value;
					}
				},
				metadata: _metadata
			}, _label_initializers, _label_extraInitializers);
			__esDecorate$5(this, null, _inputType_decorators, {
				kind: "accessor",
				name: "inputType",
				static: false,
				private: false,
				access: {
					has: (obj) => "inputType" in obj,
					get: (obj) => obj.inputType,
					set: (obj, value) => {
						obj.inputType = value;
					}
				},
				metadata: _metadata
			}, _inputType_initializers, _inputType_extraInitializers);
			__esDecorate$5(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Slider = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#value_accessor_storage = __runInitializers$5(this, _value_initializers, null);
		get value() {
			return this.#value_accessor_storage;
		}
		set value(value) {
			this.#value_accessor_storage = value;
		}
		#minValue_accessor_storage = (__runInitializers$5(this, _value_extraInitializers), __runInitializers$5(this, _minValue_initializers, 0));
		get minValue() {
			return this.#minValue_accessor_storage;
		}
		set minValue(value) {
			this.#minValue_accessor_storage = value;
		}
		#maxValue_accessor_storage = (__runInitializers$5(this, _minValue_extraInitializers), __runInitializers$5(this, _maxValue_initializers, 0));
		get maxValue() {
			return this.#maxValue_accessor_storage;
		}
		set maxValue(value) {
			this.#maxValue_accessor_storage = value;
		}
		#label_accessor_storage = (__runInitializers$5(this, _maxValue_extraInitializers), __runInitializers$5(this, _label_initializers, null));
		get label() {
			return this.#label_accessor_storage;
		}
		set label(value) {
			this.#label_accessor_storage = value;
		}
		#inputType_accessor_storage = (__runInitializers$5(this, _label_extraInitializers), __runInitializers$5(this, _inputType_initializers, null));
		get inputType() {
			return this.#inputType_accessor_storage;
		}
		set inputType(value) {
			this.#inputType_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$9`
      * {
        box-sizing: border-box;
      }

      :host {
        display: block;
        flex: var(--weight);
      }

      input {
        display: block;
        width: 100%;
      }

      .description {
      }
    `];
		}
		#setBoundValue(value) {
			if (!this.value || !this.processor) return;
			if (!("path" in this.value)) return;
			if (!this.value.path) return;
			this.processor.setData(this.component, this.value.path, value, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
		}
		#renderField(value) {
			return b`<section
      class=${e$2(this.theme.components.Slider.container)}
    >
      <label class=${e$2(this.theme.components.Slider.label)} for="data">
        ${this.label?.literalString ?? ""}
      </label>
      <input
        autocomplete="off"
        class=${e$2(this.theme.components.Slider.element)}
        style=${this.theme.additionalStyles?.Slider ? o$2(this.theme.additionalStyles?.Slider) : A}
        @input=${(evt) => {
				if (!(evt.target instanceof HTMLInputElement)) return;
				this.#setBoundValue(evt.target.value);
			}}
        id="data"
        name="data"
        .value=${value}
        type="range"
        min=${this.minValue ?? "0"}
        max=${this.maxValue ?? "0"}
      />
      <span class=${e$2(this.theme.components.Slider.label)}
        >${this.value ? extractNumberValue(this.value, this.component, this.processor, this.surfaceId) : "0"}</span
      >
    </section>`;
		}
		render() {
			if (this.value && typeof this.value === "object") {
				if ("literalNumber" in this.value && this.value.literalNumber) return this.#renderField(this.value.literalNumber);
				else if ("literal" in this.value && this.value.literal !== void 0) return this.#renderField(this.value.literal);
				else if (this.value && "path" in this.value && this.value.path) {
					if (!this.processor || !this.component) return b`(no processor)`;
					const textValue = this.processor.getData(this.component, this.value.path, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
					if (textValue === null) return b`Invalid value`;
					if (typeof textValue !== "string" && typeof textValue !== "number") return b`Invalid value`;
					return this.#renderField(textValue);
				}
			}
			return A;
		}
		constructor() {
			super(...arguments);
			__runInitializers$5(this, _inputType_extraInitializers);
		}
		static {
			__runInitializers$5(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$4 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$4 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$1("a2ui-surface")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _surfaceId_decorators;
	let _surfaceId_initializers = [];
	let _surfaceId_extraInitializers = [];
	let _surface_decorators;
	let _surface_initializers = [];
	let _surface_extraInitializers = [];
	let _processor_decorators;
	let _processor_initializers = [];
	let _processor_extraInitializers = [];
	var Surface = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_surfaceId_decorators = [n$6()];
			_surface_decorators = [n$6()];
			_processor_decorators = [n$6()];
			__esDecorate$4(this, null, _surfaceId_decorators, {
				kind: "accessor",
				name: "surfaceId",
				static: false,
				private: false,
				access: {
					has: (obj) => "surfaceId" in obj,
					get: (obj) => obj.surfaceId,
					set: (obj, value) => {
						obj.surfaceId = value;
					}
				},
				metadata: _metadata
			}, _surfaceId_initializers, _surfaceId_extraInitializers);
			__esDecorate$4(this, null, _surface_decorators, {
				kind: "accessor",
				name: "surface",
				static: false,
				private: false,
				access: {
					has: (obj) => "surface" in obj,
					get: (obj) => obj.surface,
					set: (obj, value) => {
						obj.surface = value;
					}
				},
				metadata: _metadata
			}, _surface_initializers, _surface_extraInitializers);
			__esDecorate$4(this, null, _processor_decorators, {
				kind: "accessor",
				name: "processor",
				static: false,
				private: false,
				access: {
					has: (obj) => "processor" in obj,
					get: (obj) => obj.processor,
					set: (obj, value) => {
						obj.processor = value;
					}
				},
				metadata: _metadata
			}, _processor_initializers, _processor_extraInitializers);
			__esDecorate$4(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Surface = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#surfaceId_accessor_storage = __runInitializers$4(this, _surfaceId_initializers, null);
		get surfaceId() {
			return this.#surfaceId_accessor_storage;
		}
		set surfaceId(value) {
			this.#surfaceId_accessor_storage = value;
		}
		#surface_accessor_storage = (__runInitializers$4(this, _surfaceId_extraInitializers), __runInitializers$4(this, _surface_initializers, null));
		get surface() {
			return this.#surface_accessor_storage;
		}
		set surface(value) {
			this.#surface_accessor_storage = value;
		}
		#processor_accessor_storage = (__runInitializers$4(this, _surface_extraInitializers), __runInitializers$4(this, _processor_initializers, null));
		get processor() {
			return this.#processor_accessor_storage;
		}
		set processor(value) {
			this.#processor_accessor_storage = value;
		}
		static {
			this.styles = [i$9`
      :host {
        display: flex;
        min-height: 0;
        max-height: 100%;
        flex-direction: column;
        gap: 16px;
      }

      #surface-logo {
        display: flex;
        justify-content: center;

        & img {
          width: 50%;
          max-width: 220px;
        }
      }

      a2ui-root {
        flex: 1;
      }
    `];
		}
		#renderLogo() {
			if (!this.surface?.styles.logoUrl) return A;
			return b`<div id="surface-logo">
      <img src=${this.surface.styles.logoUrl} />
    </div>`;
		}
		#renderSurface() {
			const styles = {};
			if (this.surface?.styles) for (const [key, value] of Object.entries(this.surface.styles)) switch (key) {
				case "primaryColor":
					styles["--p-100"] = "#ffffff";
					styles["--p-99"] = `color-mix(in srgb, ${value} 2%, white 98%)`;
					styles["--p-98"] = `color-mix(in srgb, ${value} 4%, white 96%)`;
					styles["--p-95"] = `color-mix(in srgb, ${value} 10%, white 90%)`;
					styles["--p-90"] = `color-mix(in srgb, ${value} 20%, white 80%)`;
					styles["--p-80"] = `color-mix(in srgb, ${value} 40%, white 60%)`;
					styles["--p-70"] = `color-mix(in srgb, ${value} 60%, white 40%)`;
					styles["--p-60"] = `color-mix(in srgb, ${value} 80%, white 20%)`;
					styles["--p-50"] = value;
					styles["--p-40"] = `color-mix(in srgb, ${value} 80%, black 20%)`;
					styles["--p-35"] = `color-mix(in srgb, ${value} 70%, black 30%)`;
					styles["--p-30"] = `color-mix(in srgb, ${value} 60%, black 40%)`;
					styles["--p-25"] = `color-mix(in srgb, ${value} 50%, black 50%)`;
					styles["--p-20"] = `color-mix(in srgb, ${value} 40%, black 60%)`;
					styles["--p-15"] = `color-mix(in srgb, ${value} 30%, black 70%)`;
					styles["--p-10"] = `color-mix(in srgb, ${value} 20%, black 80%)`;
					styles["--p-5"] = `color-mix(in srgb, ${value} 10%, black 90%)`;
					styles["--0"] = "#00000";
					break;
				case "font":
					styles["--font-family"] = value;
					styles["--font-family-flex"] = value;
					break;
			}
			return b`<a2ui-root
      style=${o$2(styles)}
      .surfaceId=${this.surfaceId}
      .processor=${this.processor}
      .childComponents=${this.surface?.componentTree ? [this.surface.componentTree] : null}
    ></a2ui-root>`;
		}
		render() {
			if (!this.surface) return A;
			return b`${[this.#renderLogo(), this.#renderSurface()]}`;
		}
		constructor() {
			super(...arguments);
			__runInitializers$4(this, _processor_extraInitializers);
		}
		static {
			__runInitializers$4(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$3 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$3 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$1("a2ui-tabs")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _titles_decorators;
	let _titles_initializers = [];
	let _titles_extraInitializers = [];
	let _selected_decorators;
	let _selected_initializers = [];
	let _selected_extraInitializers = [];
	var Tabs = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_titles_decorators = [n$6()];
			_selected_decorators = [n$6()];
			__esDecorate$3(this, null, _titles_decorators, {
				kind: "accessor",
				name: "titles",
				static: false,
				private: false,
				access: {
					has: (obj) => "titles" in obj,
					get: (obj) => obj.titles,
					set: (obj, value) => {
						obj.titles = value;
					}
				},
				metadata: _metadata
			}, _titles_initializers, _titles_extraInitializers);
			__esDecorate$3(this, null, _selected_decorators, {
				kind: "accessor",
				name: "selected",
				static: false,
				private: false,
				access: {
					has: (obj) => "selected" in obj,
					get: (obj) => obj.selected,
					set: (obj, value) => {
						obj.selected = value;
					}
				},
				metadata: _metadata
			}, _selected_initializers, _selected_extraInitializers);
			__esDecorate$3(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Tabs = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#titles_accessor_storage = __runInitializers$3(this, _titles_initializers, null);
		get titles() {
			return this.#titles_accessor_storage;
		}
		set titles(value) {
			this.#titles_accessor_storage = value;
		}
		#selected_accessor_storage = (__runInitializers$3(this, _titles_extraInitializers), __runInitializers$3(this, _selected_initializers, 0));
		get selected() {
			return this.#selected_accessor_storage;
		}
		set selected(value) {
			this.#selected_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$9`
      :host {
        display: block;
        flex: var(--weight);
      }
    `];
		}
		willUpdate(changedProperties) {
			super.willUpdate(changedProperties);
			if (changedProperties.has("selected")) {
				for (const child of this.children) child.removeAttribute("slot");
				const selectedChild = this.children[this.selected];
				if (!selectedChild) return;
				selectedChild.slot = "current";
			}
		}
		#renderTabs() {
			if (!this.titles) return A;
			return b`<div
      id="buttons"
      class=${e$2(this.theme.components.Tabs.element)}
    >
      ${c$2(this.titles, (title, idx) => {
				let titleString = "";
				if ("literalString" in title && title.literalString) titleString = title.literalString;
				else if ("literal" in title && title.literal !== void 0) titleString = title.literal;
				else if (title && "path" in title && title.path) {
					if (!this.processor || !this.component) return b`(no model)`;
					const textValue = this.processor.getData(this.component, title.path, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
					if (typeof textValue !== "string") return b`(invalid)`;
					titleString = textValue;
				}
				let classes;
				if (this.selected === idx) classes = merge(this.theme.components.Tabs.controls.all, this.theme.components.Tabs.controls.selected);
				else classes = { ...this.theme.components.Tabs.controls.all };
				return b`<button
          ?disabled=${this.selected === idx}
          class=${e$2(classes)}
          @click=${() => {
					this.selected = idx;
				}}
        >
          ${titleString}
        </button>`;
			})}
    </div>`;
		}
		#renderSlot() {
			return b`<slot name="current"></slot>`;
		}
		render() {
			return b`<section
      class=${e$2(this.theme.components.Tabs.container)}
      style=${this.theme.additionalStyles?.Tabs ? o$2(this.theme.additionalStyles?.Tabs) : A}
    >
      ${[this.#renderTabs(), this.#renderSlot()]}
    </section>`;
		}
		constructor() {
			super(...arguments);
			__runInitializers$3(this, _selected_extraInitializers);
		}
		static {
			__runInitializers$3(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate$2 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$2 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$1("a2ui-textfield")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _text_decorators;
	let _text_initializers = [];
	let _text_extraInitializers = [];
	let _label_decorators;
	let _label_initializers = [];
	let _label_extraInitializers = [];
	let _inputType_decorators;
	let _inputType_initializers = [];
	let _inputType_extraInitializers = [];
	var TextField = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_text_decorators = [n$6()];
			_label_decorators = [n$6()];
			_inputType_decorators = [n$6()];
			__esDecorate$2(this, null, _text_decorators, {
				kind: "accessor",
				name: "text",
				static: false,
				private: false,
				access: {
					has: (obj) => "text" in obj,
					get: (obj) => obj.text,
					set: (obj, value) => {
						obj.text = value;
					}
				},
				metadata: _metadata
			}, _text_initializers, _text_extraInitializers);
			__esDecorate$2(this, null, _label_decorators, {
				kind: "accessor",
				name: "label",
				static: false,
				private: false,
				access: {
					has: (obj) => "label" in obj,
					get: (obj) => obj.label,
					set: (obj, value) => {
						obj.label = value;
					}
				},
				metadata: _metadata
			}, _label_initializers, _label_extraInitializers);
			__esDecorate$2(this, null, _inputType_decorators, {
				kind: "accessor",
				name: "inputType",
				static: false,
				private: false,
				access: {
					has: (obj) => "inputType" in obj,
					get: (obj) => obj.inputType,
					set: (obj, value) => {
						obj.inputType = value;
					}
				},
				metadata: _metadata
			}, _inputType_initializers, _inputType_extraInitializers);
			__esDecorate$2(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			TextField = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#text_accessor_storage = __runInitializers$2(this, _text_initializers, null);
		get text() {
			return this.#text_accessor_storage;
		}
		set text(value) {
			this.#text_accessor_storage = value;
		}
		#label_accessor_storage = (__runInitializers$2(this, _text_extraInitializers), __runInitializers$2(this, _label_initializers, null));
		get label() {
			return this.#label_accessor_storage;
		}
		set label(value) {
			this.#label_accessor_storage = value;
		}
		#inputType_accessor_storage = (__runInitializers$2(this, _label_extraInitializers), __runInitializers$2(this, _inputType_initializers, null));
		get inputType() {
			return this.#inputType_accessor_storage;
		}
		set inputType(value) {
			this.#inputType_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$9`
      * {
        box-sizing: border-box;
      }

      :host {
        display: flex;
        flex: var(--weight);
      }

      input {
        display: block;
        width: 100%;
      }

      label {
        display: block;
        margin-bottom: 4px;
      }
    `];
		}
		#setBoundValue(value) {
			if (!this.text || !this.processor) return;
			if (!("path" in this.text)) return;
			if (!this.text.path) return;
			this.processor.setData(this.component, this.text.path, value, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
		}
		#renderField(value, label) {
			return b` <section
      class=${e$2(this.theme.components.TextField.container)}
    >
      ${label && label !== "" ? b`<label
            class=${e$2(this.theme.components.TextField.label)}
            for="data"
            >${label}</label
          >` : A}
      <input
        autocomplete="off"
        class=${e$2(this.theme.components.TextField.element)}
        style=${this.theme.additionalStyles?.TextField ? o$2(this.theme.additionalStyles?.TextField) : A}
        @input=${(evt) => {
				if (!(evt.target instanceof HTMLInputElement)) return;
				this.#setBoundValue(evt.target.value);
			}}
        name="data"
        id="data"
        .value=${value}
        .placeholder=${"Please enter a value"}
        type=${this.inputType === "number" ? "number" : "text"}
      />
    </section>`;
		}
		render() {
			const label = extractStringValue(this.label, this.component, this.processor, this.surfaceId);
			const value = extractStringValue(this.text, this.component, this.processor, this.surfaceId);
			return this.#renderField(value, label);
		}
		constructor() {
			super(...arguments);
			__runInitializers$2(this, _inputType_extraInitializers);
		}
		static {
			__runInitializers$2(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
/**
* @license
* Copyright 2017 Google LLC
* SPDX-License-Identifier: BSD-3-Clause
*/ var e = class extends i$5 {
	constructor(i) {
		if (super(i), this.it = A, i.type !== t$4.CHILD) throw Error(this.constructor.directiveName + "() can only be used in child bindings");
	}
	render(r) {
		if (r === A || null == r) return this._t = void 0, this.it = r;
		if (r === E) return r;
		if ("string" != typeof r) throw Error(this.constructor.directiveName + "() called with a non-string value");
		if (r === this.it) return this._t;
		this.it = r;
		const s = [r];
		return s.raw = s, this._t = {
			_$litType$: this.constructor.resultType,
			strings: s,
			values: []
		};
	}
};
e.directiveName = "unsafeHTML", e.resultType = 1;
const o = e$10(e);
const decodeCache = {};
function getDecodeCache(exclude) {
	let cache = decodeCache[exclude];
	if (cache) return cache;
	cache = decodeCache[exclude] = [];
	for (let i = 0; i < 128; i++) {
		const ch = String.fromCharCode(i);
		cache.push(ch);
	}
	for (let i = 0; i < exclude.length; i++) {
		const ch = exclude.charCodeAt(i);
		cache[ch] = "%" + ("0" + ch.toString(16).toUpperCase()).slice(-2);
	}
	return cache;
}
function decode$2(string, exclude) {
	if (typeof exclude !== "string") exclude = decode$2.defaultChars;
	const cache = getDecodeCache(exclude);
	return string.replace(/(%[a-f0-9]{2})+/gi, function(seq) {
		let result = "";
		for (let i = 0, l = seq.length; i < l; i += 3) {
			const b1 = parseInt(seq.slice(i + 1, i + 3), 16);
			if (b1 < 128) {
				result += cache[b1];
				continue;
			}
			if ((b1 & 224) === 192 && i + 3 < l) {
				const b2 = parseInt(seq.slice(i + 4, i + 6), 16);
				if ((b2 & 192) === 128) {
					const chr = b1 << 6 & 1984 | b2 & 63;
					if (chr < 128) result += "��";
					else result += String.fromCharCode(chr);
					i += 3;
					continue;
				}
			}
			if ((b1 & 240) === 224 && i + 6 < l) {
				const b2 = parseInt(seq.slice(i + 4, i + 6), 16);
				const b3 = parseInt(seq.slice(i + 7, i + 9), 16);
				if ((b2 & 192) === 128 && (b3 & 192) === 128) {
					const chr = b1 << 12 & 61440 | b2 << 6 & 4032 | b3 & 63;
					if (chr < 2048 || chr >= 55296 && chr <= 57343) result += "���";
					else result += String.fromCharCode(chr);
					i += 6;
					continue;
				}
			}
			if ((b1 & 248) === 240 && i + 9 < l) {
				const b2 = parseInt(seq.slice(i + 4, i + 6), 16);
				const b3 = parseInt(seq.slice(i + 7, i + 9), 16);
				const b4 = parseInt(seq.slice(i + 10, i + 12), 16);
				if ((b2 & 192) === 128 && (b3 & 192) === 128 && (b4 & 192) === 128) {
					let chr = b1 << 18 & 1835008 | b2 << 12 & 258048 | b3 << 6 & 4032 | b4 & 63;
					if (chr < 65536 || chr > 1114111) result += "����";
					else {
						chr -= 65536;
						result += String.fromCharCode(55296 + (chr >> 10), 56320 + (chr & 1023));
					}
					i += 9;
					continue;
				}
			}
			result += "�";
		}
		return result;
	});
}
decode$2.defaultChars = ";/?:@&=+$,#";
decode$2.componentChars = "";
const encodeCache = {};
function getEncodeCache(exclude) {
	let cache = encodeCache[exclude];
	if (cache) return cache;
	cache = encodeCache[exclude] = [];
	for (let i = 0; i < 128; i++) {
		const ch = String.fromCharCode(i);
		if (/^[0-9a-z]$/i.test(ch)) cache.push(ch);
		else cache.push("%" + ("0" + i.toString(16).toUpperCase()).slice(-2));
	}
	for (let i = 0; i < exclude.length; i++) cache[exclude.charCodeAt(i)] = exclude[i];
	return cache;
}
function encode$2(string, exclude, keepEscaped) {
	if (typeof exclude !== "string") {
		keepEscaped = exclude;
		exclude = encode$2.defaultChars;
	}
	if (typeof keepEscaped === "undefined") keepEscaped = true;
	const cache = getEncodeCache(exclude);
	let result = "";
	for (let i = 0, l = string.length; i < l; i++) {
		const code = string.charCodeAt(i);
		if (keepEscaped && code === 37 && i + 2 < l) {
			if (/^[0-9a-f]{2}$/i.test(string.slice(i + 1, i + 3))) {
				result += string.slice(i, i + 3);
				i += 2;
				continue;
			}
		}
		if (code < 128) {
			result += cache[code];
			continue;
		}
		if (code >= 55296 && code <= 57343) {
			if (code >= 55296 && code <= 56319 && i + 1 < l) {
				const nextCode = string.charCodeAt(i + 1);
				if (nextCode >= 56320 && nextCode <= 57343) {
					result += encodeURIComponent(string[i] + string[i + 1]);
					i++;
					continue;
				}
			}
			result += "%EF%BF%BD";
			continue;
		}
		result += encodeURIComponent(string[i]);
	}
	return result;
}
encode$2.defaultChars = ";/?:@&=+$,-_.!~*'()#";
encode$2.componentChars = "-_.!~*'()";
function format(url) {
	let result = "";
	result += url.protocol || "";
	result += url.slashes ? "//" : "";
	result += url.auth ? url.auth + "@" : "";
	if (url.hostname && url.hostname.indexOf(":") !== -1) result += "[" + url.hostname + "]";
	else result += url.hostname || "";
	result += url.port ? ":" + url.port : "";
	result += url.pathname || "";
	result += url.search || "";
	result += url.hash || "";
	return result;
}
function Url() {
	this.protocol = null;
	this.slashes = null;
	this.auth = null;
	this.port = null;
	this.hostname = null;
	this.hash = null;
	this.search = null;
	this.pathname = null;
}
const protocolPattern = /^([a-z0-9.+-]+:)/i;
const portPattern = /:[0-9]*$/;
const simplePathPattern = /^(\/\/?(?!\/)[^\?\s]*)(\?[^\s]*)?$/;
const unwise = [
	"{",
	"}",
	"|",
	"\\",
	"^",
	"`"
].concat([
	"<",
	">",
	"\"",
	"`",
	" ",
	"\r",
	"\n",
	"	"
]);
const autoEscape = ["'"].concat(unwise);
const nonHostChars = [
	"%",
	"/",
	"?",
	";",
	"#"
].concat(autoEscape);
const hostEndingChars = [
	"/",
	"?",
	"#"
];
const hostnameMaxLen = 255;
const hostnamePartPattern = /^[+a-z0-9A-Z_-]{0,63}$/;
const hostnamePartStart = /^([+a-z0-9A-Z_-]{0,63})(.*)$/;
const hostlessProtocol = {
	javascript: true,
	"javascript:": true
};
const slashedProtocol = {
	http: true,
	https: true,
	ftp: true,
	gopher: true,
	file: true,
	"http:": true,
	"https:": true,
	"ftp:": true,
	"gopher:": true,
	"file:": true
};
function urlParse(url, slashesDenoteHost) {
	if (url && url instanceof Url) return url;
	const u = new Url();
	u.parse(url, slashesDenoteHost);
	return u;
}
Url.prototype.parse = function(url, slashesDenoteHost) {
	let lowerProto, hec, slashes;
	let rest = url;
	rest = rest.trim();
	if (!slashesDenoteHost && url.split("#").length === 1) {
		const simplePath = simplePathPattern.exec(rest);
		if (simplePath) {
			this.pathname = simplePath[1];
			if (simplePath[2]) this.search = simplePath[2];
			return this;
		}
	}
	let proto = protocolPattern.exec(rest);
	if (proto) {
		proto = proto[0];
		lowerProto = proto.toLowerCase();
		this.protocol = proto;
		rest = rest.substr(proto.length);
	}
	if (slashesDenoteHost || proto || rest.match(/^\/\/[^@\/]+@[^@\/]+/)) {
		slashes = rest.substr(0, 2) === "//";
		if (slashes && !(proto && hostlessProtocol[proto])) {
			rest = rest.substr(2);
			this.slashes = true;
		}
	}
	if (!hostlessProtocol[proto] && (slashes || proto && !slashedProtocol[proto])) {
		let hostEnd = -1;
		for (let i = 0; i < hostEndingChars.length; i++) {
			hec = rest.indexOf(hostEndingChars[i]);
			if (hec !== -1 && (hostEnd === -1 || hec < hostEnd)) hostEnd = hec;
		}
		let auth, atSign;
		if (hostEnd === -1) atSign = rest.lastIndexOf("@");
		else atSign = rest.lastIndexOf("@", hostEnd);
		if (atSign !== -1) {
			auth = rest.slice(0, atSign);
			rest = rest.slice(atSign + 1);
			this.auth = auth;
		}
		hostEnd = -1;
		for (let i = 0; i < nonHostChars.length; i++) {
			hec = rest.indexOf(nonHostChars[i]);
			if (hec !== -1 && (hostEnd === -1 || hec < hostEnd)) hostEnd = hec;
		}
		if (hostEnd === -1) hostEnd = rest.length;
		if (rest[hostEnd - 1] === ":") hostEnd--;
		const host = rest.slice(0, hostEnd);
		rest = rest.slice(hostEnd);
		this.parseHost(host);
		this.hostname = this.hostname || "";
		const ipv6Hostname = this.hostname[0] === "[" && this.hostname[this.hostname.length - 1] === "]";
		if (!ipv6Hostname) {
			const hostparts = this.hostname.split(/\./);
			for (let i = 0, l = hostparts.length; i < l; i++) {
				const part = hostparts[i];
				if (!part) continue;
				if (!part.match(hostnamePartPattern)) {
					let newpart = "";
					for (let j = 0, k = part.length; j < k; j++) if (part.charCodeAt(j) > 127) newpart += "x";
					else newpart += part[j];
					if (!newpart.match(hostnamePartPattern)) {
						const validParts = hostparts.slice(0, i);
						const notHost = hostparts.slice(i + 1);
						const bit = part.match(hostnamePartStart);
						if (bit) {
							validParts.push(bit[1]);
							notHost.unshift(bit[2]);
						}
						if (notHost.length) rest = notHost.join(".") + rest;
						this.hostname = validParts.join(".");
						break;
					}
				}
			}
		}
		if (this.hostname.length > hostnameMaxLen) this.hostname = "";
		if (ipv6Hostname) this.hostname = this.hostname.substr(1, this.hostname.length - 2);
	}
	const hash = rest.indexOf("#");
	if (hash !== -1) {
		this.hash = rest.substr(hash);
		rest = rest.slice(0, hash);
	}
	const qm = rest.indexOf("?");
	if (qm !== -1) {
		this.search = rest.substr(qm);
		rest = rest.slice(0, qm);
	}
	if (rest) this.pathname = rest;
	if (slashedProtocol[lowerProto] && this.hostname && !this.pathname) this.pathname = "";
	return this;
};
Url.prototype.parseHost = function(host) {
	let port = portPattern.exec(host);
	if (port) {
		port = port[0];
		if (port !== ":") this.port = port.substr(1);
		host = host.substr(0, host.length - port.length);
	}
	if (host) this.hostname = host;
};
var mdurl_exports = /* @__PURE__ */ __exportAll({
	decode: () => decode$2,
	encode: () => encode$2,
	format: () => format,
	parse: () => urlParse
});
var regex_default$5 = /[\0-\uD7FF\uE000-\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;
var regex_default$4 = /[\0-\x1F\x7F-\x9F]/;
var regex_default$3 = /[\xAD\u0600-\u0605\u061C\u06DD\u070F\u0890\u0891\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]|\uD804[\uDCBD\uDCCD]|\uD80D[\uDC30-\uDC3F]|\uD82F[\uDCA0-\uDCA3]|\uD834[\uDD73-\uDD7A]|\uDB40[\uDC01\uDC20-\uDC7F]/;
var regex_default$2 = /[!-#%-\*,-\/:;\?@\[-\]_\{\}\xA1\xA7\xAB\xB6\xB7\xBB\xBF\u037E\u0387\u055A-\u055F\u0589\u058A\u05BE\u05C0\u05C3\u05C6\u05F3\u05F4\u0609\u060A\u060C\u060D\u061B\u061D-\u061F\u066A-\u066D\u06D4\u0700-\u070D\u07F7-\u07F9\u0830-\u083E\u085E\u0964\u0965\u0970\u09FD\u0A76\u0AF0\u0C77\u0C84\u0DF4\u0E4F\u0E5A\u0E5B\u0F04-\u0F12\u0F14\u0F3A-\u0F3D\u0F85\u0FD0-\u0FD4\u0FD9\u0FDA\u104A-\u104F\u10FB\u1360-\u1368\u1400\u166E\u169B\u169C\u16EB-\u16ED\u1735\u1736\u17D4-\u17D6\u17D8-\u17DA\u1800-\u180A\u1944\u1945\u1A1E\u1A1F\u1AA0-\u1AA6\u1AA8-\u1AAD\u1B5A-\u1B60\u1B7D\u1B7E\u1BFC-\u1BFF\u1C3B-\u1C3F\u1C7E\u1C7F\u1CC0-\u1CC7\u1CD3\u2010-\u2027\u2030-\u2043\u2045-\u2051\u2053-\u205E\u207D\u207E\u208D\u208E\u2308-\u230B\u2329\u232A\u2768-\u2775\u27C5\u27C6\u27E6-\u27EF\u2983-\u2998\u29D8-\u29DB\u29FC\u29FD\u2CF9-\u2CFC\u2CFE\u2CFF\u2D70\u2E00-\u2E2E\u2E30-\u2E4F\u2E52-\u2E5D\u3001-\u3003\u3008-\u3011\u3014-\u301F\u3030\u303D\u30A0\u30FB\uA4FE\uA4FF\uA60D-\uA60F\uA673\uA67E\uA6F2-\uA6F7\uA874-\uA877\uA8CE\uA8CF\uA8F8-\uA8FA\uA8FC\uA92E\uA92F\uA95F\uA9C1-\uA9CD\uA9DE\uA9DF\uAA5C-\uAA5F\uAADE\uAADF\uAAF0\uAAF1\uABEB\uFD3E\uFD3F\uFE10-\uFE19\uFE30-\uFE52\uFE54-\uFE61\uFE63\uFE68\uFE6A\uFE6B\uFF01-\uFF03\uFF05-\uFF0A\uFF0C-\uFF0F\uFF1A\uFF1B\uFF1F\uFF20\uFF3B-\uFF3D\uFF3F\uFF5B\uFF5D\uFF5F-\uFF65]|\uD800[\uDD00-\uDD02\uDF9F\uDFD0]|\uD801\uDD6F|\uD802[\uDC57\uDD1F\uDD3F\uDE50-\uDE58\uDE7F\uDEF0-\uDEF6\uDF39-\uDF3F\uDF99-\uDF9C]|\uD803[\uDEAD\uDF55-\uDF59\uDF86-\uDF89]|\uD804[\uDC47-\uDC4D\uDCBB\uDCBC\uDCBE-\uDCC1\uDD40-\uDD43\uDD74\uDD75\uDDC5-\uDDC8\uDDCD\uDDDB\uDDDD-\uDDDF\uDE38-\uDE3D\uDEA9]|\uD805[\uDC4B-\uDC4F\uDC5A\uDC5B\uDC5D\uDCC6\uDDC1-\uDDD7\uDE41-\uDE43\uDE60-\uDE6C\uDEB9\uDF3C-\uDF3E]|\uD806[\uDC3B\uDD44-\uDD46\uDDE2\uDE3F-\uDE46\uDE9A-\uDE9C\uDE9E-\uDEA2\uDF00-\uDF09]|\uD807[\uDC41-\uDC45\uDC70\uDC71\uDEF7\uDEF8\uDF43-\uDF4F\uDFFF]|\uD809[\uDC70-\uDC74]|\uD80B[\uDFF1\uDFF2]|\uD81A[\uDE6E\uDE6F\uDEF5\uDF37-\uDF3B\uDF44]|\uD81B[\uDE97-\uDE9A\uDFE2]|\uD82F\uDC9F|\uD836[\uDE87-\uDE8B]|\uD83A[\uDD5E\uDD5F]/;
var regex_default$1 = /[\$\+<->\^`\|~\xA2-\xA6\xA8\xA9\xAC\xAE-\xB1\xB4\xB8\xD7\xF7\u02C2-\u02C5\u02D2-\u02DF\u02E5-\u02EB\u02ED\u02EF-\u02FF\u0375\u0384\u0385\u03F6\u0482\u058D-\u058F\u0606-\u0608\u060B\u060E\u060F\u06DE\u06E9\u06FD\u06FE\u07F6\u07FE\u07FF\u0888\u09F2\u09F3\u09FA\u09FB\u0AF1\u0B70\u0BF3-\u0BFA\u0C7F\u0D4F\u0D79\u0E3F\u0F01-\u0F03\u0F13\u0F15-\u0F17\u0F1A-\u0F1F\u0F34\u0F36\u0F38\u0FBE-\u0FC5\u0FC7-\u0FCC\u0FCE\u0FCF\u0FD5-\u0FD8\u109E\u109F\u1390-\u1399\u166D\u17DB\u1940\u19DE-\u19FF\u1B61-\u1B6A\u1B74-\u1B7C\u1FBD\u1FBF-\u1FC1\u1FCD-\u1FCF\u1FDD-\u1FDF\u1FED-\u1FEF\u1FFD\u1FFE\u2044\u2052\u207A-\u207C\u208A-\u208C\u20A0-\u20C0\u2100\u2101\u2103-\u2106\u2108\u2109\u2114\u2116-\u2118\u211E-\u2123\u2125\u2127\u2129\u212E\u213A\u213B\u2140-\u2144\u214A-\u214D\u214F\u218A\u218B\u2190-\u2307\u230C-\u2328\u232B-\u2426\u2440-\u244A\u249C-\u24E9\u2500-\u2767\u2794-\u27C4\u27C7-\u27E5\u27F0-\u2982\u2999-\u29D7\u29DC-\u29FB\u29FE-\u2B73\u2B76-\u2B95\u2B97-\u2BFF\u2CE5-\u2CEA\u2E50\u2E51\u2E80-\u2E99\u2E9B-\u2EF3\u2F00-\u2FD5\u2FF0-\u2FFF\u3004\u3012\u3013\u3020\u3036\u3037\u303E\u303F\u309B\u309C\u3190\u3191\u3196-\u319F\u31C0-\u31E3\u31EF\u3200-\u321E\u322A-\u3247\u3250\u3260-\u327F\u328A-\u32B0\u32C0-\u33FF\u4DC0-\u4DFF\uA490-\uA4C6\uA700-\uA716\uA720\uA721\uA789\uA78A\uA828-\uA82B\uA836-\uA839\uAA77-\uAA79\uAB5B\uAB6A\uAB6B\uFB29\uFBB2-\uFBC2\uFD40-\uFD4F\uFDCF\uFDFC-\uFDFF\uFE62\uFE64-\uFE66\uFE69\uFF04\uFF0B\uFF1C-\uFF1E\uFF3E\uFF40\uFF5C\uFF5E\uFFE0-\uFFE6\uFFE8-\uFFEE\uFFFC\uFFFD]|\uD800[\uDD37-\uDD3F\uDD79-\uDD89\uDD8C-\uDD8E\uDD90-\uDD9C\uDDA0\uDDD0-\uDDFC]|\uD802[\uDC77\uDC78\uDEC8]|\uD805\uDF3F|\uD807[\uDFD5-\uDFF1]|\uD81A[\uDF3C-\uDF3F\uDF45]|\uD82F\uDC9C|\uD833[\uDF50-\uDFC3]|\uD834[\uDC00-\uDCF5\uDD00-\uDD26\uDD29-\uDD64\uDD6A-\uDD6C\uDD83\uDD84\uDD8C-\uDDA9\uDDAE-\uDDEA\uDE00-\uDE41\uDE45\uDF00-\uDF56]|\uD835[\uDEC1\uDEDB\uDEFB\uDF15\uDF35\uDF4F\uDF6F\uDF89\uDFA9\uDFC3]|\uD836[\uDC00-\uDDFF\uDE37-\uDE3A\uDE6D-\uDE74\uDE76-\uDE83\uDE85\uDE86]|\uD838[\uDD4F\uDEFF]|\uD83B[\uDCAC\uDCB0\uDD2E\uDEF0\uDEF1]|\uD83C[\uDC00-\uDC2B\uDC30-\uDC93\uDCA0-\uDCAE\uDCB1-\uDCBF\uDCC1-\uDCCF\uDCD1-\uDCF5\uDD0D-\uDDAD\uDDE6-\uDE02\uDE10-\uDE3B\uDE40-\uDE48\uDE50\uDE51\uDE60-\uDE65\uDF00-\uDFFF]|\uD83D[\uDC00-\uDED7\uDEDC-\uDEEC\uDEF0-\uDEFC\uDF00-\uDF76\uDF7B-\uDFD9\uDFE0-\uDFEB\uDFF0]|\uD83E[\uDC00-\uDC0B\uDC10-\uDC47\uDC50-\uDC59\uDC60-\uDC87\uDC90-\uDCAD\uDCB0\uDCB1\uDD00-\uDE53\uDE60-\uDE6D\uDE70-\uDE7C\uDE80-\uDE88\uDE90-\uDEBD\uDEBF-\uDEC5\uDECE-\uDEDB\uDEE0-\uDEE8\uDEF0-\uDEF8\uDF00-\uDF92\uDF94-\uDFCA]/;
var regex_default = /[ \xA0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;
var uc_micro_exports = /* @__PURE__ */ __exportAll({
	Any: () => regex_default$5,
	Cc: () => regex_default$4,
	Cf: () => regex_default$3,
	P: () => regex_default$2,
	S: () => regex_default$1,
	Z: () => regex_default
});
var decode_data_html_default = new Uint16Array("ᵁ<Õıʊҝջאٵ۞ޢߖࠏ੊ઑඡ๭༉༦჊ረዡᐕᒝᓃᓟᔥ\0\0\0\0\0\0ᕫᛍᦍᰒᷝ὾⁠↰⊍⏀⏻⑂⠤⤒ⴈ⹈⿎〖㊺㘹㞬㣾㨨㩱㫠㬮ࠀEMabcfglmnoprstu\\bfms¦³¹ÈÏlig耻Æ䃆P耻&䀦cute耻Á䃁reve;䄂Āiyx}rc耻Â䃂;䐐r;쀀𝔄rave耻À䃀pha;䎑acr;䄀d;橓Āgp¡on;䄄f;쀀𝔸plyFunction;恡ing耻Å䃅Ācs¾Ãr;쀀𝒜ign;扔ilde耻Ã䃃ml耻Ä䃄ЀaceforsuåûþėĜĢħĪĀcrêòkslash;或Ŷöø;櫧ed;挆y;䐑ƀcrtąċĔause;戵noullis;愬a;䎒r;쀀𝔅pf;쀀𝔹eve;䋘còēmpeq;扎܀HOacdefhilorsuōőŖƀƞƢƵƷƺǜȕɳɸɾcy;䐧PY耻©䂩ƀcpyŝŢźute;䄆Ā;iŧŨ拒talDifferentialD;慅leys;愭ȀaeioƉƎƔƘron;䄌dil耻Ç䃇rc;䄈nint;戰ot;䄊ĀdnƧƭilla;䂸terDot;䂷òſi;䎧rcleȀDMPTǇǋǑǖot;抙inus;抖lus;投imes;抗oĀcsǢǸkwiseContourIntegral;戲eCurlyĀDQȃȏoubleQuote;思uote;怙ȀlnpuȞȨɇɕonĀ;eȥȦ户;橴ƀgitȯȶȺruent;扡nt;戯ourIntegral;戮ĀfrɌɎ;愂oduct;成nterClockwiseContourIntegral;戳oss;樯cr;쀀𝒞pĀ;Cʄʅ拓ap;才րDJSZacefiosʠʬʰʴʸˋ˗ˡ˦̳ҍĀ;oŹʥtrahd;椑cy;䐂cy;䐅cy;䐏ƀgrsʿ˄ˇger;怡r;憡hv;櫤Āayː˕ron;䄎;䐔lĀ;t˝˞戇a;䎔r;쀀𝔇Āaf˫̧Ācm˰̢riticalȀADGT̖̜̀̆cute;䂴oŴ̋̍;䋙bleAcute;䋝rave;䁠ilde;䋜ond;拄ferentialD;慆Ѱ̽\0\0\0͔͂\0Ѕf;쀀𝔻ƀ;DE͈͉͍䂨ot;惜qual;扐blèCDLRUVͣͲ΂ϏϢϸontourIntegraìȹoɴ͹\0\0ͻ»͉nArrow;懓Āeo·ΤftƀARTΐΖΡrrow;懐ightArrow;懔eåˊngĀLRΫτeftĀARγιrrow;柸ightArrow;柺ightArrow;柹ightĀATϘϞrrow;懒ee;抨pɁϩ\0\0ϯrrow;懑ownArrow;懕erticalBar;戥ǹABLRTaВЪаўѿͼrrowƀ;BUНОТ憓ar;椓pArrow;懵reve;䌑eft˒к\0ц\0ѐightVector;楐eeVector;楞ectorĀ;Bљњ憽ar;楖ightǔѧ\0ѱeeVector;楟ectorĀ;BѺѻ懁ar;楗eeĀ;A҆҇护rrow;憧ĀctҒҗr;쀀𝒟rok;䄐ࠀNTacdfglmopqstuxҽӀӄӋӞӢӧӮӵԡԯԶՒ՝ՠեG;䅊H耻Ð䃐cute耻É䃉ƀaiyӒӗӜron;䄚rc耻Ê䃊;䐭ot;䄖r;쀀𝔈rave耻È䃈ement;戈ĀapӺӾcr;䄒tyɓԆ\0\0ԒmallSquare;旻erySmallSquare;斫ĀgpԦԪon;䄘f;쀀𝔼silon;䎕uĀaiԼՉlĀ;TՂՃ橵ilde;扂librium;懌Āci՗՚r;愰m;橳a;䎗ml耻Ë䃋Āipժկsts;戃onentialE;慇ʀcfiosօֈ֍ֲ׌y;䐤r;쀀𝔉lledɓ֗\0\0֣mallSquare;旼erySmallSquare;斪Ͱֺ\0ֿ\0\0ׄf;쀀𝔽All;戀riertrf;愱cò׋؀JTabcdfgorstר׬ׯ׺؀ؒؖ؛؝أ٬ٲcy;䐃耻>䀾mmaĀ;d׷׸䎓;䏜reve;䄞ƀeiy؇،ؐdil;䄢rc;䄜;䐓ot;䄠r;쀀𝔊;拙pf;쀀𝔾eater̀EFGLSTصلَٖٛ٦qualĀ;Lؾؿ扥ess;招ullEqual;执reater;檢ess;扷lantEqual;橾ilde;扳cr;쀀𝒢;扫ЀAacfiosuڅڋږڛڞڪھۊRDcy;䐪Āctڐڔek;䋇;䁞irc;䄤r;愌lbertSpace;愋ǰگ\0ڲf;愍izontalLine;攀Āctۃۅòکrok;䄦mpńېۘownHumðįqual;扏܀EJOacdfgmnostuۺ۾܃܇܎ܚܞܡܨ݄ݸދޏޕcy;䐕lig;䄲cy;䐁cute耻Í䃍Āiyܓܘrc耻Î䃎;䐘ot;䄰r;愑rave耻Ì䃌ƀ;apܠܯܿĀcgܴܷr;䄪inaryI;慈lieóϝǴ݉\0ݢĀ;eݍݎ戬Āgrݓݘral;戫section;拂isibleĀCTݬݲomma;恣imes;恢ƀgptݿރވon;䄮f;쀀𝕀a;䎙cr;愐ilde;䄨ǫޚ\0ޞcy;䐆l耻Ï䃏ʀcfosuެ޷޼߂ߐĀiyޱ޵rc;䄴;䐙r;쀀𝔍pf;쀀𝕁ǣ߇\0ߌr;쀀𝒥rcy;䐈kcy;䐄΀HJacfosߤߨ߽߬߱ࠂࠈcy;䐥cy;䐌ppa;䎚Āey߶߻dil;䄶;䐚r;쀀𝔎pf;쀀𝕂cr;쀀𝒦րJTaceflmostࠥࠩࠬࡐࡣ঳সে্਷ੇcy;䐉耻<䀼ʀcmnpr࠷࠼ࡁࡄࡍute;䄹bda;䎛g;柪lacetrf;愒r;憞ƀaeyࡗ࡜ࡡron;䄽dil;䄻;䐛Āfsࡨ॰tԀACDFRTUVarࡾࢩࢱࣦ࣠ࣼयज़ΐ४Ānrࢃ࢏gleBracket;柨rowƀ;BR࢙࢚࢞憐ar;懤ightArrow;懆eiling;挈oǵࢷ\0ࣃbleBracket;柦nǔࣈ\0࣒eeVector;楡ectorĀ;Bࣛࣜ懃ar;楙loor;挊ightĀAV࣯ࣵrrow;憔ector;楎Āerँगeƀ;AVउऊऐ抣rrow;憤ector;楚iangleƀ;BEतथऩ抲ar;槏qual;抴pƀDTVषूौownVector;楑eeVector;楠ectorĀ;Bॖॗ憿ar;楘ectorĀ;B॥०憼ar;楒ightáΜs̀EFGLSTॾঋকঝঢভqualGreater;拚ullEqual;扦reater;扶ess;檡lantEqual;橽ilde;扲r;쀀𝔏Ā;eঽা拘ftarrow;懚idot;䄿ƀnpw৔ਖਛgȀLRlr৞৷ਂਐeftĀAR০৬rrow;柵ightArrow;柷ightArrow;柶eftĀarγਊightáοightáϊf;쀀𝕃erĀLRਢਬeftArrow;憙ightArrow;憘ƀchtਾੀੂòࡌ;憰rok;䅁;扪Ѐacefiosuਗ਼੝੠੷੼અઋ઎p;椅y;䐜Ādl੥੯iumSpace;恟lintrf;愳r;쀀𝔐nusPlus;戓pf;쀀𝕄cò੶;䎜ҀJacefostuણધભીଔଙඑ඗ඞcy;䐊cute;䅃ƀaey઴હાron;䅇dil;䅅;䐝ƀgswે૰଎ativeƀMTV૓૟૨ediumSpace;怋hiĀcn૦૘ë૙eryThiî૙tedĀGL૸ଆreaterGreateòٳessLesóੈLine;䀊r;쀀𝔑ȀBnptଢନଷ଺reak;恠BreakingSpace;䂠f;愕ڀ;CDEGHLNPRSTV୕ୖ୪୼஡௫ఄ౞಄ದ೘ൡඅ櫬Āou୛୤ngruent;扢pCap;扭oubleVerticalBar;戦ƀlqxஃஊ஛ement;戉ualĀ;Tஒஓ扠ilde;쀀≂̸ists;戄reater΀;EFGLSTஶஷ஽௉௓௘௥扯qual;扱ullEqual;쀀≧̸reater;쀀≫̸ess;批lantEqual;쀀⩾̸ilde;扵umpń௲௽ownHump;쀀≎̸qual;쀀≏̸eĀfsఊధtTriangleƀ;BEచఛడ拪ar;쀀⧏̸qual;括s̀;EGLSTవశ఼ౄోౘ扮qual;扰reater;扸ess;쀀≪̸lantEqual;쀀⩽̸ilde;扴estedĀGL౨౹reaterGreater;쀀⪢̸essLess;쀀⪡̸recedesƀ;ESಒಓಛ技qual;쀀⪯̸lantEqual;拠ĀeiಫಹverseElement;戌ghtTriangleƀ;BEೋೌ೒拫ar;쀀⧐̸qual;拭ĀquೝഌuareSuĀbp೨೹setĀ;E೰ೳ쀀⊏̸qual;拢ersetĀ;Eഃആ쀀⊐̸qual;拣ƀbcpഓതൎsetĀ;Eഛഞ쀀⊂⃒qual;抈ceedsȀ;ESTലള഻െ抁qual;쀀⪰̸lantEqual;拡ilde;쀀≿̸ersetĀ;E൘൛쀀⊃⃒qual;抉ildeȀ;EFT൮൯൵ൿ扁qual;扄ullEqual;扇ilde;扉erticalBar;戤cr;쀀𝒩ilde耻Ñ䃑;䎝܀Eacdfgmoprstuvලෂ෉෕ෛ෠෧෼ขภยา฿ไlig;䅒cute耻Ó䃓Āiy෎ීrc耻Ô䃔;䐞blac;䅐r;쀀𝔒rave耻Ò䃒ƀaei෮ෲ෶cr;䅌ga;䎩cron;䎟pf;쀀𝕆enCurlyĀDQฎบoubleQuote;怜uote;怘;橔Āclวฬr;쀀𝒪ash耻Ø䃘iŬื฼de耻Õ䃕es;樷ml耻Ö䃖erĀBP๋๠Āar๐๓r;怾acĀek๚๜;揞et;掴arenthesis;揜Ҁacfhilors๿ງຊຏຒດຝະ໼rtialD;戂y;䐟r;쀀𝔓i;䎦;䎠usMinus;䂱Āipຢອncareplanåڝf;愙Ȁ;eio຺ູ໠໤檻cedesȀ;EST່້໏໚扺qual;檯lantEqual;扼ilde;找me;怳Ādp໩໮uct;戏ortionĀ;aȥ໹l;戝Āci༁༆r;쀀𝒫;䎨ȀUfos༑༖༛༟OT耻\"䀢r;쀀𝔔pf;愚cr;쀀𝒬؀BEacefhiorsu༾གྷཇའཱིྦྷྪྭ႖ႩႴႾarr;椐G耻®䂮ƀcnrཎནབute;䅔g;柫rĀ;tཛྷཝ憠l;椖ƀaeyཧཬཱron;䅘dil;䅖;䐠Ā;vླྀཹ愜erseĀEUྂྙĀlq྇ྎement;戋uilibrium;懋pEquilibrium;楯r»ཹo;䎡ghtЀACDFTUVa࿁࿫࿳ဢဨၛႇϘĀnr࿆࿒gleBracket;柩rowƀ;BL࿜࿝࿡憒ar;懥eftArrow;懄eiling;按oǵ࿹\0စbleBracket;柧nǔည\0နeeVector;楝ectorĀ;Bဝသ懂ar;楕loor;挋Āerိ၃eƀ;AVဵံြ抢rrow;憦ector;楛iangleƀ;BEၐၑၕ抳ar;槐qual;抵pƀDTVၣၮၸownVector;楏eeVector;楜ectorĀ;Bႂႃ憾ar;楔ectorĀ;B႑႒懀ar;楓Āpuႛ႞f;愝ndImplies;楰ightarrow;懛ĀchႹႼr;愛;憱leDelayed;槴ڀHOacfhimoqstuფჱჷჽᄙᄞᅑᅖᅡᅧᆵᆻᆿĀCcჩხHcy;䐩y;䐨FTcy;䐬cute;䅚ʀ;aeiyᄈᄉᄎᄓᄗ檼ron;䅠dil;䅞rc;䅜;䐡r;쀀𝔖ortȀDLRUᄪᄴᄾᅉownArrow»ОeftArrow»࢚ightArrow»࿝pArrow;憑gma;䎣allCircle;战pf;쀀𝕊ɲᅭ\0\0ᅰt;戚areȀ;ISUᅻᅼᆉᆯ斡ntersection;抓uĀbpᆏᆞsetĀ;Eᆗᆘ抏qual;抑ersetĀ;Eᆨᆩ抐qual;抒nion;抔cr;쀀𝒮ar;拆ȀbcmpᇈᇛሉላĀ;sᇍᇎ拐etĀ;Eᇍᇕqual;抆ĀchᇠህeedsȀ;ESTᇭᇮᇴᇿ扻qual;檰lantEqual;扽ilde;承Tháྌ;我ƀ;esሒሓሣ拑rsetĀ;Eሜም抃qual;抇et»ሓրHRSacfhiorsሾቄ቉ቕ቞ቱቶኟዂወዑORN耻Þ䃞ADE;愢ĀHc቎ቒcy;䐋y;䐦Ābuቚቜ;䀉;䎤ƀaeyብቪቯron;䅤dil;䅢;䐢r;쀀𝔗Āeiቻ኉ǲኀ\0ኇefore;戴a;䎘Ācn኎ኘkSpace;쀀  Space;怉ldeȀ;EFTካኬኲኼ戼qual;扃ullEqual;扅ilde;扈pf;쀀𝕋ipleDot;惛Āctዖዛr;쀀𝒯rok;䅦ૡዷጎጚጦ\0ጬጱ\0\0\0\0\0ጸጽ፷ᎅ\0᏿ᐄᐊᐐĀcrዻጁute耻Ú䃚rĀ;oጇገ憟cir;楉rǣጓ\0጖y;䐎ve;䅬Āiyጞጣrc耻Û䃛;䐣blac;䅰r;쀀𝔘rave耻Ù䃙acr;䅪Ādiፁ፩erĀBPፈ፝Āarፍፐr;䁟acĀekፗፙ;揟et;掵arenthesis;揝onĀ;P፰፱拃lus;抎Āgp፻፿on;䅲f;쀀𝕌ЀADETadps᎕ᎮᎸᏄϨᏒᏗᏳrrowƀ;BDᅐᎠᎤar;椒ownArrow;懅ownArrow;憕quilibrium;楮eeĀ;AᏋᏌ报rrow;憥ownáϳerĀLRᏞᏨeftArrow;憖ightArrow;憗iĀ;lᏹᏺ䏒on;䎥ing;䅮cr;쀀𝒰ilde;䅨ml耻Ü䃜ҀDbcdefosvᐧᐬᐰᐳᐾᒅᒊᒐᒖash;披ar;櫫y;䐒ashĀ;lᐻᐼ抩;櫦Āerᑃᑅ;拁ƀbtyᑌᑐᑺar;怖Ā;iᑏᑕcalȀBLSTᑡᑥᑪᑴar;戣ine;䁼eparator;杘ilde;所ThinSpace;怊r;쀀𝔙pf;쀀𝕍cr;쀀𝒱dash;抪ʀcefosᒧᒬᒱᒶᒼirc;䅴dge;拀r;쀀𝔚pf;쀀𝕎cr;쀀𝒲Ȁfiosᓋᓐᓒᓘr;쀀𝔛;䎞pf;쀀𝕏cr;쀀𝒳ҀAIUacfosuᓱᓵᓹᓽᔄᔏᔔᔚᔠcy;䐯cy;䐇cy;䐮cute耻Ý䃝Āiyᔉᔍrc;䅶;䐫r;쀀𝔜pf;쀀𝕐cr;쀀𝒴ml;䅸ЀHacdefosᔵᔹᔿᕋᕏᕝᕠᕤcy;䐖cute;䅹Āayᕄᕉron;䅽;䐗ot;䅻ǲᕔ\0ᕛoWidtè૙a;䎖r;愨pf;愤cr;쀀𝒵௡ᖃᖊᖐ\0ᖰᖶᖿ\0\0\0\0ᗆᗛᗫᙟ᙭\0ᚕ᚛ᚲᚹ\0ᚾcute耻á䃡reve;䄃̀;Ediuyᖜᖝᖡᖣᖨᖭ戾;쀀∾̳;房rc耻â䃢te肻´̆;䐰lig耻æ䃦Ā;r²ᖺ;쀀𝔞rave耻à䃠ĀepᗊᗖĀfpᗏᗔsym;愵èᗓha;䎱ĀapᗟcĀclᗤᗧr;䄁g;樿ɤᗰ\0\0ᘊʀ;adsvᗺᗻᗿᘁᘇ戧nd;橕;橜lope;橘;橚΀;elmrszᘘᘙᘛᘞᘿᙏᙙ戠;榤e»ᘙsdĀ;aᘥᘦ戡ѡᘰᘲᘴᘶᘸᘺᘼᘾ;榨;榩;榪;榫;榬;榭;榮;榯tĀ;vᙅᙆ戟bĀ;dᙌᙍ抾;榝Āptᙔᙗh;戢»¹arr;捼Āgpᙣᙧon;䄅f;쀀𝕒΀;Eaeiop዁ᙻᙽᚂᚄᚇᚊ;橰cir;橯;扊d;手s;䀧roxĀ;e዁ᚒñᚃing耻å䃥ƀctyᚡᚦᚨr;쀀𝒶;䀪mpĀ;e዁ᚯñʈilde耻ã䃣ml耻ä䃤Āciᛂᛈoninôɲnt;樑ࠀNabcdefiklnoprsu᛭ᛱᜰ᜼ᝃᝈ᝸᝽០៦ᠹᡐᜍ᤽᥈ᥰot;櫭Ācrᛶ᜞kȀcepsᜀᜅᜍᜓong;扌psilon;䏶rime;怵imĀ;e᜚᜛戽q;拍Ŷᜢᜦee;抽edĀ;gᜬᜭ挅e»ᜭrkĀ;t፜᜷brk;掶Āoyᜁᝁ;䐱quo;怞ʀcmprtᝓ᝛ᝡᝤᝨausĀ;eĊĉptyv;榰séᜌnoõēƀahwᝯ᝱ᝳ;䎲;愶een;扬r;쀀𝔟g΀costuvwឍឝឳេ៕៛៞ƀaiuបពរðݠrc;旯p»፱ƀdptឤឨឭot;樀lus;樁imes;樂ɱឹ\0\0ើcup;樆ar;昅riangleĀdu៍្own;施p;斳plus;樄eåᑄåᒭarow;植ƀako៭ᠦᠵĀcn៲ᠣkƀlst៺֫᠂ozenge;槫riangleȀ;dlr᠒᠓᠘᠝斴own;斾eft;旂ight;斸k;搣Ʊᠫ\0ᠳƲᠯ\0ᠱ;斒;斑4;斓ck;斈ĀeoᠾᡍĀ;qᡃᡆ쀀=⃥uiv;쀀≡⃥t;挐Ȁptwxᡙᡞᡧᡬf;쀀𝕓Ā;tᏋᡣom»Ꮜtie;拈؀DHUVbdhmptuvᢅᢖᢪᢻᣗᣛᣬ᣿ᤅᤊᤐᤡȀLRlrᢎᢐᢒᢔ;敗;敔;敖;敓ʀ;DUduᢡᢢᢤᢦᢨ敐;敦;敩;敤;敧ȀLRlrᢳᢵᢷᢹ;敝;敚;敜;教΀;HLRhlrᣊᣋᣍᣏᣑᣓᣕ救;敬;散;敠;敫;敢;敟ox;槉ȀLRlrᣤᣦᣨᣪ;敕;敒;攐;攌ʀ;DUduڽ᣷᣹᣻᣽;敥;敨;攬;攴inus;抟lus;択imes;抠ȀLRlrᤙᤛᤝ᤟;敛;敘;攘;攔΀;HLRhlrᤰᤱᤳᤵᤷ᤻᤹攂;敪;敡;敞;攼;攤;攜Āevģ᥂bar耻¦䂦Ȁceioᥑᥖᥚᥠr;쀀𝒷mi;恏mĀ;e᜚᜜lƀ;bhᥨᥩᥫ䁜;槅sub;柈Ŭᥴ᥾lĀ;e᥹᥺怢t»᥺pƀ;Eeįᦅᦇ;檮Ā;qۜۛೡᦧ\0᧨ᨑᨕᨲ\0ᨷᩐ\0\0᪴\0\0᫁\0\0ᬡᬮ᭍᭒\0᯽\0ᰌƀcpr᦭ᦲ᧝ute;䄇̀;abcdsᦿᧀᧄ᧊᧕᧙戩nd;橄rcup;橉Āau᧏᧒p;橋p;橇ot;橀;쀀∩︀Āeo᧢᧥t;恁îړȀaeiu᧰᧻ᨁᨅǰ᧵\0᧸s;橍on;䄍dil耻ç䃧rc;䄉psĀ;sᨌᨍ橌m;橐ot;䄋ƀdmnᨛᨠᨦil肻¸ƭptyv;榲t脀¢;eᨭᨮ䂢räƲr;쀀𝔠ƀceiᨽᩀᩍy;䑇ckĀ;mᩇᩈ朓ark»ᩈ;䏇r΀;Ecefms᩟᩠ᩢᩫ᪤᪪᪮旋;槃ƀ;elᩩᩪᩭ䋆q;扗eɡᩴ\0\0᪈rrowĀlr᩼᪁eft;憺ight;憻ʀRSacd᪒᪔᪖᪚᪟»ཇ;擈st;抛irc;抚ash;抝nint;樐id;櫯cir;槂ubsĀ;u᪻᪼晣it»᪼ˬ᫇᫔᫺\0ᬊonĀ;eᫍᫎ䀺Ā;qÇÆɭ᫙\0\0᫢aĀ;t᫞᫟䀬;䁀ƀ;fl᫨᫩᫫戁îᅠeĀmx᫱᫶ent»᫩eóɍǧ᫾\0ᬇĀ;dኻᬂot;橭nôɆƀfryᬐᬔᬗ;쀀𝕔oäɔ脀©;sŕᬝr;愗Āaoᬥᬩrr;憵ss;朗Ācuᬲᬷr;쀀𝒸Ābpᬼ᭄Ā;eᭁᭂ櫏;櫑Ā;eᭉᭊ櫐;櫒dot;拯΀delprvw᭠᭬᭷ᮂᮬᯔ᯹arrĀlr᭨᭪;椸;椵ɰ᭲\0\0᭵r;拞c;拟arrĀ;p᭿ᮀ憶;椽̀;bcdosᮏᮐᮖᮡᮥᮨ截rcap;橈Āauᮛᮞp;橆p;橊ot;抍r;橅;쀀∪︀Ȁalrv᮵ᮿᯞᯣrrĀ;mᮼᮽ憷;椼yƀevwᯇᯔᯘqɰᯎ\0\0ᯒreã᭳uã᭵ee;拎edge;拏en耻¤䂤earrowĀlrᯮ᯳eft»ᮀight»ᮽeäᯝĀciᰁᰇoninôǷnt;戱lcty;挭ঀAHabcdefhijlorstuwz᰸᰻᰿ᱝᱩᱵᲊᲞᲬᲷ᳻᳿ᴍᵻᶑᶫᶻ᷆᷍rò΁ar;楥Ȁglrs᱈ᱍ᱒᱔ger;怠eth;愸òᄳhĀ;vᱚᱛ怐»ऊūᱡᱧarow;椏aã̕Āayᱮᱳron;䄏;䐴ƀ;ao̲ᱼᲄĀgrʿᲁr;懊tseq;橷ƀglmᲑᲔᲘ耻°䂰ta;䎴ptyv;榱ĀirᲣᲨsht;楿;쀀𝔡arĀlrᲳᲵ»ࣜ»သʀaegsv᳂͸᳖᳜᳠mƀ;oș᳊᳔ndĀ;ș᳑uit;晦amma;䏝in;拲ƀ;io᳧᳨᳸䃷de脀÷;o᳧ᳰntimes;拇nø᳷cy;䑒cɯᴆ\0\0ᴊrn;挞op;挍ʀlptuwᴘᴝᴢᵉᵕlar;䀤f;쀀𝕕ʀ;emps̋ᴭᴷᴽᵂqĀ;d͒ᴳot;扑inus;戸lus;戔quare;抡blebarwedgåúnƀadhᄮᵝᵧownarrowóᲃarpoonĀlrᵲᵶefôᲴighôᲶŢᵿᶅkaro÷གɯᶊ\0\0ᶎrn;挟op;挌ƀcotᶘᶣᶦĀryᶝᶡ;쀀𝒹;䑕l;槶rok;䄑Ādrᶰᶴot;拱iĀ;fᶺ᠖斿Āah᷀᷃ròЩaòྦangle;榦Āci᷒ᷕy;䑟grarr;柿ऀDacdefglmnopqrstuxḁḉḙḸոḼṉṡṾấắẽỡἪἷὄ὎὚ĀDoḆᴴoôᲉĀcsḎḔute耻é䃩ter;橮ȀaioyḢḧḱḶron;䄛rĀ;cḭḮ扖耻ê䃪lon;払;䑍ot;䄗ĀDrṁṅot;扒;쀀𝔢ƀ;rsṐṑṗ檚ave耻è䃨Ā;dṜṝ檖ot;檘Ȁ;ilsṪṫṲṴ檙nters;揧;愓Ā;dṹṺ檕ot;檗ƀapsẅẉẗcr;䄓tyƀ;svẒẓẕ戅et»ẓpĀ1;ẝẤĳạả;怄;怅怃ĀgsẪẬ;䅋p;怂ĀgpẴẸon;䄙f;쀀𝕖ƀalsỄỎỒrĀ;sỊị拕l;槣us;橱iƀ;lvỚớở䎵on»ớ;䏵ȀcsuvỪỳἋἣĀioữḱrc»Ḯɩỹ\0\0ỻíՈantĀglἂἆtr»ṝess»Ṻƀaeiἒ἖Ἒls;䀽st;扟vĀ;DȵἠD;橸parsl;槥ĀDaἯἳot;打rr;楱ƀcdiἾὁỸr;愯oô͒ĀahὉὋ;䎷耻ð䃰Āmrὓὗl耻ë䃫o;悬ƀcipὡὤὧl;䀡sôծĀeoὬὴctatioîՙnentialåչৡᾒ\0ᾞ\0ᾡᾧ\0\0ῆῌ\0ΐ\0ῦῪ \0 ⁚llingdotseñṄy;䑄male;晀ƀilrᾭᾳ῁lig;耀ﬃɩᾹ\0\0᾽g;耀ﬀig;耀ﬄ;쀀𝔣lig;耀ﬁlig;쀀fjƀaltῙ῜ῡt;晭ig;耀ﬂns;斱of;䆒ǰ΅\0ῳf;쀀𝕗ĀakֿῷĀ;vῼ´拔;櫙artint;樍Āao‌⁕Ācs‑⁒α‚‰‸⁅⁈\0⁐β•‥‧‪‬\0‮耻½䂽;慓耻¼䂼;慕;慙;慛Ƴ‴\0‶;慔;慖ʴ‾⁁\0\0⁃耻¾䂾;慗;慜5;慘ƶ⁌\0⁎;慚;慝8;慞l;恄wn;挢cr;쀀𝒻ࢀEabcdefgijlnorstv₂₉₟₥₰₴⃰⃵⃺⃿℃ℒℸ̗ℾ⅒↞Ā;lٍ₇;檌ƀcmpₐₕ₝ute;䇵maĀ;dₜ᳚䎳;檆reve;䄟Āiy₪₮rc;䄝;䐳ot;䄡Ȁ;lqsؾق₽⃉ƀ;qsؾٌ⃄lanô٥Ȁ;cdl٥⃒⃥⃕c;檩otĀ;o⃜⃝檀Ā;l⃢⃣檂;檄Ā;e⃪⃭쀀⋛︀s;檔r;쀀𝔤Ā;gٳ؛mel;愷cy;䑓Ȁ;Eajٚℌℎℐ;檒;檥;檤ȀEaesℛℝ℩ℴ;扩pĀ;p℣ℤ檊rox»ℤĀ;q℮ℯ檈Ā;q℮ℛim;拧pf;쀀𝕘Āci⅃ⅆr;愊mƀ;el٫ⅎ⅐;檎;檐茀>;cdlqr׮ⅠⅪⅮⅳⅹĀciⅥⅧ;檧r;橺ot;拗Par;榕uest;橼ʀadelsↄⅪ←ٖ↛ǰ↉\0↎proø₞r;楸qĀlqؿ↖lesó₈ií٫Āen↣↭rtneqq;쀀≩︀Å↪ԀAabcefkosy⇄⇇⇱⇵⇺∘∝∯≨≽ròΠȀilmr⇐⇔⇗⇛rsðᒄf»․ilôکĀdr⇠⇤cy;䑊ƀ;cwࣴ⇫⇯ir;楈;憭ar;意irc;䄥ƀalr∁∎∓rtsĀ;u∉∊晥it»∊lip;怦con;抹r;쀀𝔥sĀew∣∩arow;椥arow;椦ʀamopr∺∾≃≞≣rr;懿tht;戻kĀlr≉≓eftarrow;憩ightarrow;憪f;쀀𝕙bar;怕ƀclt≯≴≸r;쀀𝒽asè⇴rok;䄧Ābp⊂⊇ull;恃hen»ᱛૡ⊣\0⊪\0⊸⋅⋎\0⋕⋳\0\0⋸⌢⍧⍢⍿\0⎆⎪⎴cute耻í䃭ƀ;iyݱ⊰⊵rc耻î䃮;䐸Ācx⊼⊿y;䐵cl耻¡䂡ĀfrΟ⋉;쀀𝔦rave耻ì䃬Ȁ;inoܾ⋝⋩⋮Āin⋢⋦nt;樌t;戭fin;槜ta;愩lig;䄳ƀaop⋾⌚⌝ƀcgt⌅⌈⌗r;䄫ƀelpܟ⌏⌓inåގarôܠh;䄱f;抷ed;䆵ʀ;cfotӴ⌬⌱⌽⍁are;愅inĀ;t⌸⌹戞ie;槝doô⌙ʀ;celpݗ⍌⍐⍛⍡al;抺Āgr⍕⍙eróᕣã⍍arhk;樗rod;樼Ȁcgpt⍯⍲⍶⍻y;䑑on;䄯f;쀀𝕚a;䎹uest耻¿䂿Āci⎊⎏r;쀀𝒾nʀ;EdsvӴ⎛⎝⎡ӳ;拹ot;拵Ā;v⎦⎧拴;拳Ā;iݷ⎮lde;䄩ǫ⎸\0⎼cy;䑖l耻ï䃯̀cfmosu⏌⏗⏜⏡⏧⏵Āiy⏑⏕rc;䄵;䐹r;쀀𝔧ath;䈷pf;쀀𝕛ǣ⏬\0⏱r;쀀𝒿rcy;䑘kcy;䑔Ѐacfghjos␋␖␢␧␭␱␵␻ppaĀ;v␓␔䎺;䏰Āey␛␠dil;䄷;䐺r;쀀𝔨reen;䄸cy;䑅cy;䑜pf;쀀𝕜cr;쀀𝓀஀ABEHabcdefghjlmnoprstuv⑰⒁⒆⒍⒑┎┽╚▀♎♞♥♹♽⚚⚲⛘❝❨➋⟀⠁⠒ƀart⑷⑺⑼rò৆òΕail;椛arr;椎Ā;gঔ⒋;檋ar;楢ॣ⒥\0⒪\0⒱\0\0\0\0\0⒵Ⓔ\0ⓆⓈⓍ\0⓹ute;䄺mptyv;榴raîࡌbda;䎻gƀ;dlࢎⓁⓃ;榑åࢎ;檅uo耻«䂫rЀ;bfhlpst࢙ⓞⓦⓩ⓫⓮⓱⓵Ā;f࢝ⓣs;椟s;椝ë≒p;憫l;椹im;楳l;憢ƀ;ae⓿─┄檫il;椙Ā;s┉┊檭;쀀⪭︀ƀabr┕┙┝rr;椌rk;杲Āak┢┬cĀek┨┪;䁻;䁛Āes┱┳;榋lĀdu┹┻;榏;榍Ȁaeuy╆╋╖╘ron;䄾Ādi═╔il;䄼ìࢰâ┩;䐻Ȁcqrs╣╦╭╽a;椶uoĀ;rนᝆĀdu╲╷har;楧shar;楋h;憲ʀ;fgqs▋▌উ◳◿扤tʀahlrt▘▤▷◂◨rrowĀ;t࢙□aé⓶arpoonĀdu▯▴own»њp»०eftarrows;懇ightƀahs◍◖◞rrowĀ;sࣴࢧarpoonó྘quigarro÷⇰hreetimes;拋ƀ;qs▋ও◺lanôবʀ;cdgsব☊☍☝☨c;檨otĀ;o☔☕橿Ā;r☚☛檁;檃Ā;e☢☥쀀⋚︀s;檓ʀadegs☳☹☽♉♋pproøⓆot;拖qĀgq♃♅ôউgtò⒌ôছiíলƀilr♕࣡♚sht;楼;쀀𝔩Ā;Eজ♣;檑š♩♶rĀdu▲♮Ā;l॥♳;楪lk;斄cy;䑙ʀ;achtੈ⚈⚋⚑⚖rò◁orneòᴈard;楫ri;旺Āio⚟⚤dot;䅀ustĀ;a⚬⚭掰che»⚭ȀEaes⚻⚽⛉⛔;扨pĀ;p⛃⛄檉rox»⛄Ā;q⛎⛏檇Ā;q⛎⚻im;拦Ѐabnoptwz⛩⛴⛷✚✯❁❇❐Ānr⛮⛱g;柬r;懽rëࣁgƀlmr⛿✍✔eftĀar০✇ightá৲apsto;柼ightá৽parrowĀlr✥✩efô⓭ight;憬ƀafl✶✹✽r;榅;쀀𝕝us;樭imes;樴š❋❏st;戗áፎƀ;ef❗❘᠀旊nge»❘arĀ;l❤❥䀨t;榓ʀachmt❳❶❼➅➇ròࢨorneòᶌarĀ;d྘➃;業;怎ri;抿̀achiqt➘➝ੀ➢➮➻quo;怹r;쀀𝓁mƀ;egল➪➬;檍;檏Ābu┪➳oĀ;rฟ➹;怚rok;䅂萀<;cdhilqrࠫ⟒☹⟜⟠⟥⟪⟰Āci⟗⟙;檦r;橹reå◲mes;拉arr;楶uest;橻ĀPi⟵⟹ar;榖ƀ;ef⠀भ᠛旃rĀdu⠇⠍shar;楊har;楦Āen⠗⠡rtneqq;쀀≨︀Å⠞܀Dacdefhilnopsu⡀⡅⢂⢎⢓⢠⢥⢨⣚⣢⣤ઃ⣳⤂Dot;戺Ȁclpr⡎⡒⡣⡽r耻¯䂯Āet⡗⡙;時Ā;e⡞⡟朠se»⡟Ā;sျ⡨toȀ;dluျ⡳⡷⡻owîҌefôएðᏑker;斮Āoy⢇⢌mma;権;䐼ash;怔asuredangle»ᘦr;쀀𝔪o;愧ƀcdn⢯⢴⣉ro耻µ䂵Ȁ;acdᑤ⢽⣀⣄sôᚧir;櫰ot肻·Ƶusƀ;bd⣒ᤃ⣓戒Ā;uᴼ⣘;横ţ⣞⣡p;櫛ò−ðઁĀdp⣩⣮els;抧f;쀀𝕞Āct⣸⣽r;쀀𝓂pos»ᖝƀ;lm⤉⤊⤍䎼timap;抸ఀGLRVabcdefghijlmoprstuvw⥂⥓⥾⦉⦘⧚⧩⨕⨚⩘⩝⪃⪕⪤⪨⬄⬇⭄⭿⮮ⰴⱧⱼ⳩Āgt⥇⥋;쀀⋙̸Ā;v⥐௏쀀≫⃒ƀelt⥚⥲⥶ftĀar⥡⥧rrow;懍ightarrow;懎;쀀⋘̸Ā;v⥻ే쀀≪⃒ightarrow;懏ĀDd⦎⦓ash;抯ash;抮ʀbcnpt⦣⦧⦬⦱⧌la»˞ute;䅄g;쀀∠⃒ʀ;Eiop඄⦼⧀⧅⧈;쀀⩰̸d;쀀≋̸s;䅉roø඄urĀ;a⧓⧔普lĀ;s⧓ସǳ⧟\0⧣p肻\xA0ଷmpĀ;e௹ఀʀaeouy⧴⧾⨃⨐⨓ǰ⧹\0⧻;橃on;䅈dil;䅆ngĀ;dൾ⨊ot;쀀⩭̸p;橂;䐽ash;怓΀;Aadqsxஒ⨩⨭⨻⩁⩅⩐rr;懗rĀhr⨳⨶k;椤Ā;oᏲᏰot;쀀≐̸uiöୣĀei⩊⩎ar;椨í஘istĀ;s஠டr;쀀𝔫ȀEest௅⩦⩹⩼ƀ;qs஼⩭௡ƀ;qs஼௅⩴lanô௢ií௪Ā;rஶ⪁»ஷƀAap⪊⪍⪑rò⥱rr;憮ar;櫲ƀ;svྍ⪜ྌĀ;d⪡⪢拼;拺cy;䑚΀AEadest⪷⪺⪾⫂⫅⫶⫹rò⥦;쀀≦̸rr;憚r;急Ȁ;fqs఻⫎⫣⫯tĀar⫔⫙rro÷⫁ightarro÷⪐ƀ;qs఻⪺⫪lanôౕĀ;sౕ⫴»శiíౝĀ;rవ⫾iĀ;eచథiäඐĀpt⬌⬑f;쀀𝕟膀¬;in⬙⬚⬶䂬nȀ;Edvஉ⬤⬨⬮;쀀⋹̸ot;쀀⋵̸ǡஉ⬳⬵;拷;拶iĀ;vಸ⬼ǡಸ⭁⭃;拾;拽ƀaor⭋⭣⭩rȀ;ast୻⭕⭚⭟lleì୻l;쀀⫽⃥;쀀∂̸lint;樔ƀ;ceಒ⭰⭳uåಥĀ;cಘ⭸Ā;eಒ⭽ñಘȀAait⮈⮋⮝⮧rò⦈rrƀ;cw⮔⮕⮙憛;쀀⤳̸;쀀↝̸ghtarrow»⮕riĀ;eೋೖ΀chimpqu⮽⯍⯙⬄୸⯤⯯Ȁ;cerല⯆ഷ⯉uå൅;쀀𝓃ortɭ⬅\0\0⯖ará⭖mĀ;e൮⯟Ā;q൴൳suĀbp⯫⯭å೸åഋƀbcp⯶ⰑⰙȀ;Ees⯿ⰀഢⰄ抄;쀀⫅̸etĀ;eഛⰋqĀ;qണⰀcĀ;eലⰗñസȀ;EesⰢⰣൟⰧ抅;쀀⫆̸etĀ;e൘ⰮqĀ;qൠⰣȀgilrⰽⰿⱅⱇìௗlde耻ñ䃱çృiangleĀlrⱒⱜeftĀ;eచⱚñదightĀ;eೋⱥñ೗Ā;mⱬⱭ䎽ƀ;esⱴⱵⱹ䀣ro;愖p;怇ҀDHadgilrsⲏⲔⲙⲞⲣⲰⲶⳓⳣash;抭arr;椄p;쀀≍⃒ash;抬ĀetⲨⲬ;쀀≥⃒;쀀>⃒nfin;槞ƀAetⲽⳁⳅrr;椂;쀀≤⃒Ā;rⳊⳍ쀀<⃒ie;쀀⊴⃒ĀAtⳘⳜrr;椃rie;쀀⊵⃒im;쀀∼⃒ƀAan⳰⳴ⴂrr;懖rĀhr⳺⳽k;椣Ā;oᏧᏥear;椧ቓ᪕\0\0\0\0\0\0\0\0\0\0\0\0\0ⴭ\0ⴸⵈⵠⵥ⵲ⶄᬇ\0\0ⶍⶫ\0ⷈⷎ\0ⷜ⸙⸫⸾⹃Ācsⴱ᪗ute耻ó䃳ĀiyⴼⵅrĀ;c᪞ⵂ耻ô䃴;䐾ʀabios᪠ⵒⵗǈⵚlac;䅑v;樸old;榼lig;䅓Ācr⵩⵭ir;榿;쀀𝔬ͯ⵹\0\0⵼\0ⶂn;䋛ave耻ò䃲;槁Ābmⶈ෴ar;榵Ȁacitⶕ⶘ⶥⶨrò᪀Āir⶝ⶠr;榾oss;榻nå๒;槀ƀaeiⶱⶵⶹcr;䅍ga;䏉ƀcdnⷀⷅǍron;䎿;榶pf;쀀𝕠ƀaelⷔ⷗ǒr;榷rp;榹΀;adiosvⷪⷫⷮ⸈⸍⸐⸖戨rò᪆Ȁ;efmⷷⷸ⸂⸅橝rĀ;oⷾⷿ愴f»ⷿ耻ª䂪耻º䂺gof;抶r;橖lope;橗;橛ƀclo⸟⸡⸧ò⸁ash耻ø䃸l;折iŬⸯ⸴de耻õ䃵esĀ;aǛ⸺s;樶ml耻ö䃶bar;挽ૡ⹞\0⹽\0⺀⺝\0⺢⺹\0\0⻋ຜ\0⼓\0\0⼫⾼\0⿈rȀ;astЃ⹧⹲຅脀¶;l⹭⹮䂶leìЃɩ⹸\0\0⹻m;櫳;櫽y;䐿rʀcimpt⺋⺏⺓ᡥ⺗nt;䀥od;䀮il;怰enk;怱r;쀀𝔭ƀimo⺨⺰⺴Ā;v⺭⺮䏆;䏕maô੶ne;明ƀ;tv⺿⻀⻈䏀chfork»´;䏖Āau⻏⻟nĀck⻕⻝kĀ;h⇴⻛;愎ö⇴sҀ;abcdemst⻳⻴ᤈ⻹⻽⼄⼆⼊⼎䀫cir;樣ir;樢Āouᵀ⼂;樥;橲n肻±ຝim;樦wo;樧ƀipu⼙⼠⼥ntint;樕f;쀀𝕡nd耻£䂣Ԁ;Eaceinosu່⼿⽁⽄⽇⾁⾉⾒⽾⾶;檳p;檷uå໙Ā;c໎⽌̀;acens່⽙⽟⽦⽨⽾pproø⽃urlyeñ໙ñ໎ƀaes⽯⽶⽺pprox;檹qq;檵im;拨iíໟmeĀ;s⾈ຮ怲ƀEas⽸⾐⽺ð⽵ƀdfp໬⾙⾯ƀals⾠⾥⾪lar;挮ine;挒urf;挓Ā;t໻⾴ï໻rel;抰Āci⿀⿅r;쀀𝓅;䏈ncsp;怈̀fiopsu⿚⋢⿟⿥⿫⿱r;쀀𝔮pf;쀀𝕢rime;恗cr;쀀𝓆ƀaeo⿸〉〓tĀei⿾々rnionóڰnt;樖stĀ;e【】䀿ñἙô༔઀ABHabcdefhilmnoprstux぀けさすムㄎㄫㅇㅢㅲㆎ㈆㈕㈤㈩㉘㉮㉲㊐㊰㊷ƀartぇおがròႳòϝail;検aròᱥar;楤΀cdenqrtとふへみわゔヌĀeuねぱ;쀀∽̱te;䅕iãᅮmptyv;榳gȀ;del࿑らるろ;榒;榥å࿑uo耻»䂻rր;abcfhlpstw࿜ガクシスゼゾダッデナp;極Ā;f࿠ゴs;椠;椳s;椞ë≝ð✮l;楅im;楴l;憣;憝Āaiパフil;椚oĀ;nホボ戶aló༞ƀabrョリヮrò៥rk;杳ĀakンヽcĀekヹ・;䁽;䁝Āes㄂㄄;榌lĀduㄊㄌ;榎;榐Ȁaeuyㄗㄜㄧㄩron;䅙Ādiㄡㄥil;䅗ì࿲âヺ;䑀Ȁclqsㄴㄷㄽㅄa;椷dhar;楩uoĀ;rȎȍh;憳ƀacgㅎㅟངlȀ;ipsླྀㅘㅛႜnåႻarôྩt;断ƀilrㅩဣㅮsht;楽;쀀𝔯ĀaoㅷㆆrĀduㅽㅿ»ѻĀ;l႑ㆄ;楬Ā;vㆋㆌ䏁;䏱ƀgns㆕ㇹㇼht̀ahlrstㆤㆰ㇂㇘㇤㇮rrowĀ;t࿜ㆭaéトarpoonĀduㆻㆿowîㅾp»႒eftĀah㇊㇐rrowó࿪arpoonóՑightarrows;應quigarro÷ニhreetimes;拌g;䋚ingdotseñἲƀahm㈍㈐㈓rò࿪aòՑ;怏oustĀ;a㈞㈟掱che»㈟mid;櫮Ȁabpt㈲㈽㉀㉒Ānr㈷㈺g;柭r;懾rëဃƀafl㉇㉊㉎r;榆;쀀𝕣us;樮imes;樵Āap㉝㉧rĀ;g㉣㉤䀩t;榔olint;樒arò㇣Ȁachq㉻㊀Ⴜ㊅quo;怺r;쀀𝓇Ābu・㊊oĀ;rȔȓƀhir㊗㊛㊠reåㇸmes;拊iȀ;efl㊪ၙᠡ㊫方tri;槎luhar;楨;愞ൡ㋕㋛㋟㌬㌸㍱\0㍺㎤\0\0㏬㏰\0㐨㑈㑚㒭㒱㓊㓱\0㘖\0\0㘳cute;䅛quï➺Ԁ;Eaceinpsyᇭ㋳㋵㋿㌂㌋㌏㌟㌦㌩;檴ǰ㋺\0㋼;檸on;䅡uåᇾĀ;dᇳ㌇il;䅟rc;䅝ƀEas㌖㌘㌛;檶p;檺im;择olint;樓iíሄ;䑁otƀ;be㌴ᵇ㌵担;橦΀Aacmstx㍆㍊㍗㍛㍞㍣㍭rr;懘rĀhr㍐㍒ë∨Ā;oਸ਼਴t耻§䂧i;䀻war;椩mĀin㍩ðnuóñt;朶rĀ;o㍶⁕쀀𝔰Ȁacoy㎂㎆㎑㎠rp;景Āhy㎋㎏cy;䑉;䑈rtɭ㎙\0\0㎜iäᑤaraì⹯耻­䂭Āgm㎨㎴maƀ;fv㎱㎲㎲䏃;䏂Ѐ;deglnprካ㏅㏉㏎㏖㏞㏡㏦ot;橪Ā;q኱ኰĀ;E㏓㏔檞;檠Ā;E㏛㏜檝;檟e;扆lus;樤arr;楲aròᄽȀaeit㏸㐈㐏㐗Āls㏽㐄lsetmé㍪hp;樳parsl;槤Ādlᑣ㐔e;挣Ā;e㐜㐝檪Ā;s㐢㐣檬;쀀⪬︀ƀflp㐮㐳㑂tcy;䑌Ā;b㐸㐹䀯Ā;a㐾㐿槄r;挿f;쀀𝕤aĀdr㑍ЂesĀ;u㑔㑕晠it»㑕ƀcsu㑠㑹㒟Āau㑥㑯pĀ;sᆈ㑫;쀀⊓︀pĀ;sᆴ㑵;쀀⊔︀uĀbp㑿㒏ƀ;esᆗᆜ㒆etĀ;eᆗ㒍ñᆝƀ;esᆨᆭ㒖etĀ;eᆨ㒝ñᆮƀ;afᅻ㒦ְrť㒫ֱ»ᅼaròᅈȀcemt㒹㒾㓂㓅r;쀀𝓈tmîñiì㐕aræᆾĀar㓎㓕rĀ;f㓔ឿ昆Āan㓚㓭ightĀep㓣㓪psiloîỠhé⺯s»⡒ʀbcmnp㓻㕞ሉ㖋㖎Ҁ;Edemnprs㔎㔏㔑㔕㔞㔣㔬㔱㔶抂;櫅ot;檽Ā;dᇚ㔚ot;櫃ult;櫁ĀEe㔨㔪;櫋;把lus;檿arr;楹ƀeiu㔽㕒㕕tƀ;en㔎㕅㕋qĀ;qᇚ㔏eqĀ;q㔫㔨m;櫇Ābp㕚㕜;櫕;櫓c̀;acensᇭ㕬㕲㕹㕻㌦pproø㋺urlyeñᇾñᇳƀaes㖂㖈㌛pproø㌚qñ㌗g;晪ڀ123;Edehlmnps㖩㖬㖯ሜ㖲㖴㗀㗉㗕㗚㗟㗨㗭耻¹䂹耻²䂲耻³䂳;櫆Āos㖹㖼t;檾ub;櫘Ā;dሢ㗅ot;櫄sĀou㗏㗒l;柉b;櫗arr;楻ult;櫂ĀEe㗤㗦;櫌;抋lus;櫀ƀeiu㗴㘉㘌tƀ;enሜ㗼㘂qĀ;qሢ㖲eqĀ;q㗧㗤m;櫈Ābp㘑㘓;櫔;櫖ƀAan㘜㘠㘭rr;懙rĀhr㘦㘨ë∮Ā;oਫ਩war;椪lig耻ß䃟௡㙑㙝㙠ዎ㙳㙹\0㙾㛂\0\0\0\0\0㛛㜃\0㜉㝬\0\0\0㞇ɲ㙖\0\0㙛get;挖;䏄rë๟ƀaey㙦㙫㙰ron;䅥dil;䅣;䑂lrec;挕r;쀀𝔱Ȁeiko㚆㚝㚵㚼ǲ㚋\0㚑eĀ4fኄኁaƀ;sv㚘㚙㚛䎸ym;䏑Ācn㚢㚲kĀas㚨㚮pproø዁im»ኬsðኞĀas㚺㚮ð዁rn耻þ䃾Ǭ̟㛆⋧es膀×;bd㛏㛐㛘䃗Ā;aᤏ㛕r;樱;樰ƀeps㛡㛣㜀á⩍Ȁ;bcf҆㛬㛰㛴ot;挶ir;櫱Ā;o㛹㛼쀀𝕥rk;櫚á㍢rime;怴ƀaip㜏㜒㝤dåቈ΀adempst㜡㝍㝀㝑㝗㝜㝟ngleʀ;dlqr㜰㜱㜶㝀㝂斵own»ᶻeftĀ;e⠀㜾ñम;扜ightĀ;e㊪㝋ñၚot;旬inus;樺lus;樹b;槍ime;樻ezium;揢ƀcht㝲㝽㞁Āry㝷㝻;쀀𝓉;䑆cy;䑛rok;䅧Āio㞋㞎xô᝷headĀlr㞗㞠eftarro÷ࡏightarrow»ཝऀAHabcdfghlmoprstuw㟐㟓㟗㟤㟰㟼㠎㠜㠣㠴㡑㡝㡫㢩㣌㣒㣪㣶ròϭar;楣Ācr㟜㟢ute耻ú䃺òᅐrǣ㟪\0㟭y;䑞ve;䅭Āiy㟵㟺rc耻û䃻;䑃ƀabh㠃㠆㠋ròᎭlac;䅱aòᏃĀir㠓㠘sht;楾;쀀𝔲rave耻ù䃹š㠧㠱rĀlr㠬㠮»ॗ»ႃlk;斀Āct㠹㡍ɯ㠿\0\0㡊rnĀ;e㡅㡆挜r»㡆op;挏ri;旸Āal㡖㡚cr;䅫肻¨͉Āgp㡢㡦on;䅳f;쀀𝕦̀adhlsuᅋ㡸㡽፲㢑㢠ownáᎳarpoonĀlr㢈㢌efô㠭ighô㠯iƀ;hl㢙㢚㢜䏅»ᏺon»㢚parrows;懈ƀcit㢰㣄㣈ɯ㢶\0\0㣁rnĀ;e㢼㢽挝r»㢽op;挎ng;䅯ri;旹cr;쀀𝓊ƀdir㣙㣝㣢ot;拰lde;䅩iĀ;f㜰㣨»᠓Āam㣯㣲rò㢨l耻ü䃼angle;榧ހABDacdeflnoprsz㤜㤟㤩㤭㦵㦸㦽㧟㧤㧨㧳㧹㧽㨁㨠ròϷarĀ;v㤦㤧櫨;櫩asèϡĀnr㤲㤷grt;榜΀eknprst㓣㥆㥋㥒㥝㥤㦖appá␕othinçẖƀhir㓫⻈㥙opô⾵Ā;hᎷ㥢ïㆍĀiu㥩㥭gmá㎳Ābp㥲㦄setneqĀ;q㥽㦀쀀⊊︀;쀀⫋︀setneqĀ;q㦏㦒쀀⊋︀;쀀⫌︀Āhr㦛㦟etá㚜iangleĀlr㦪㦯eft»थight»ၑy;䐲ash»ံƀelr㧄㧒㧗ƀ;beⷪ㧋㧏ar;抻q;扚lip;拮Ābt㧜ᑨaòᑩr;쀀𝔳tré㦮suĀbp㧯㧱»ജ»൙pf;쀀𝕧roð໻tré㦴Ācu㨆㨋r;쀀𝓋Ābp㨐㨘nĀEe㦀㨖»㥾nĀEe㦒㨞»㦐igzag;榚΀cefoprs㨶㨻㩖㩛㩔㩡㩪irc;䅵Ādi㩀㩑Ābg㩅㩉ar;機eĀ;qᗺ㩏;扙erp;愘r;쀀𝔴pf;쀀𝕨Ā;eᑹ㩦atèᑹcr;쀀𝓌ૣណ㪇\0㪋\0㪐㪛\0\0㪝㪨㪫㪯\0\0㫃㫎\0㫘ៜ៟tré៑r;쀀𝔵ĀAa㪔㪗ròσrò৶;䎾ĀAa㪡㪤ròθrò৫að✓is;拻ƀdptឤ㪵㪾Āfl㪺ឩ;쀀𝕩imåឲĀAa㫇㫊ròώròਁĀcq㫒ីr;쀀𝓍Āpt៖㫜ré។Ѐacefiosu㫰㫽㬈㬌㬑㬕㬛㬡cĀuy㫶㫻te耻ý䃽;䑏Āiy㬂㬆rc;䅷;䑋n耻¥䂥r;쀀𝔶cy;䑗pf;쀀𝕪cr;쀀𝓎Ācm㬦㬩y;䑎l耻ÿ䃿Ԁacdefhiosw㭂㭈㭔㭘㭤㭩㭭㭴㭺㮀cute;䅺Āay㭍㭒ron;䅾;䐷ot;䅼Āet㭝㭡træᕟa;䎶r;쀀𝔷cy;䐶grarr;懝pf;쀀𝕫cr;쀀𝓏Ājn㮅㮇;怍j;怌".split("").map((c) => c.charCodeAt(0)));
var decode_data_xml_default = new Uint16Array("Ȁaglq	\x1Bɭ\0\0p;䀦os;䀧t;䀾t;䀼uot;䀢".split("").map((c) => c.charCodeAt(0)));
var _a;
const decodeMap = new Map([
	[0, 65533],
	[128, 8364],
	[130, 8218],
	[131, 402],
	[132, 8222],
	[133, 8230],
	[134, 8224],
	[135, 8225],
	[136, 710],
	[137, 8240],
	[138, 352],
	[139, 8249],
	[140, 338],
	[142, 381],
	[145, 8216],
	[146, 8217],
	[147, 8220],
	[148, 8221],
	[149, 8226],
	[150, 8211],
	[151, 8212],
	[152, 732],
	[153, 8482],
	[154, 353],
	[155, 8250],
	[156, 339],
	[158, 382],
	[159, 376]
]);
/**
* Polyfill for `String.fromCodePoint`. It is used to create a string from a Unicode code point.
*/
const fromCodePoint$1 = (_a = String.fromCodePoint) !== null && _a !== void 0 ? _a : function(codePoint) {
	let output = "";
	if (codePoint > 65535) {
		codePoint -= 65536;
		output += String.fromCharCode(codePoint >>> 10 & 1023 | 55296);
		codePoint = 56320 | codePoint & 1023;
	}
	output += String.fromCharCode(codePoint);
	return output;
};
/**
* Replace the given code point with a replacement character if it is a
* surrogate or is outside the valid range. Otherwise return the code
* point unchanged.
*/
function replaceCodePoint(codePoint) {
	var _a;
	if (codePoint >= 55296 && codePoint <= 57343 || codePoint > 1114111) return 65533;
	return (_a = decodeMap.get(codePoint)) !== null && _a !== void 0 ? _a : codePoint;
}
var CharCodes;
(function(CharCodes) {
	CharCodes[CharCodes["NUM"] = 35] = "NUM";
	CharCodes[CharCodes["SEMI"] = 59] = "SEMI";
	CharCodes[CharCodes["EQUALS"] = 61] = "EQUALS";
	CharCodes[CharCodes["ZERO"] = 48] = "ZERO";
	CharCodes[CharCodes["NINE"] = 57] = "NINE";
	CharCodes[CharCodes["LOWER_A"] = 97] = "LOWER_A";
	CharCodes[CharCodes["LOWER_F"] = 102] = "LOWER_F";
	CharCodes[CharCodes["LOWER_X"] = 120] = "LOWER_X";
	CharCodes[CharCodes["LOWER_Z"] = 122] = "LOWER_Z";
	CharCodes[CharCodes["UPPER_A"] = 65] = "UPPER_A";
	CharCodes[CharCodes["UPPER_F"] = 70] = "UPPER_F";
	CharCodes[CharCodes["UPPER_Z"] = 90] = "UPPER_Z";
})(CharCodes || (CharCodes = {}));
/** Bit that needs to be set to convert an upper case ASCII character to lower case */
const TO_LOWER_BIT = 32;
var BinTrieFlags;
(function(BinTrieFlags) {
	BinTrieFlags[BinTrieFlags["VALUE_LENGTH"] = 49152] = "VALUE_LENGTH";
	BinTrieFlags[BinTrieFlags["BRANCH_LENGTH"] = 16256] = "BRANCH_LENGTH";
	BinTrieFlags[BinTrieFlags["JUMP_TABLE"] = 127] = "JUMP_TABLE";
})(BinTrieFlags || (BinTrieFlags = {}));
function isNumber(code) {
	return code >= CharCodes.ZERO && code <= CharCodes.NINE;
}
function isHexadecimalCharacter(code) {
	return code >= CharCodes.UPPER_A && code <= CharCodes.UPPER_F || code >= CharCodes.LOWER_A && code <= CharCodes.LOWER_F;
}
function isAsciiAlphaNumeric(code) {
	return code >= CharCodes.UPPER_A && code <= CharCodes.UPPER_Z || code >= CharCodes.LOWER_A && code <= CharCodes.LOWER_Z || isNumber(code);
}
/**
* Checks if the given character is a valid end character for an entity in an attribute.
*
* Attribute values that aren't terminated properly aren't parsed, and shouldn't lead to a parser error.
* See the example in https://html.spec.whatwg.org/multipage/parsing.html#named-character-reference-state
*/
function isEntityInAttributeInvalidEnd(code) {
	return code === CharCodes.EQUALS || isAsciiAlphaNumeric(code);
}
var EntityDecoderState;
(function(EntityDecoderState) {
	EntityDecoderState[EntityDecoderState["EntityStart"] = 0] = "EntityStart";
	EntityDecoderState[EntityDecoderState["NumericStart"] = 1] = "NumericStart";
	EntityDecoderState[EntityDecoderState["NumericDecimal"] = 2] = "NumericDecimal";
	EntityDecoderState[EntityDecoderState["NumericHex"] = 3] = "NumericHex";
	EntityDecoderState[EntityDecoderState["NamedEntity"] = 4] = "NamedEntity";
})(EntityDecoderState || (EntityDecoderState = {}));
var DecodingMode;
(function(DecodingMode) {
	/** Entities in text nodes that can end with any character. */
	DecodingMode[DecodingMode["Legacy"] = 0] = "Legacy";
	/** Only allow entities terminated with a semicolon. */
	DecodingMode[DecodingMode["Strict"] = 1] = "Strict";
	/** Entities in attributes have limitations on ending characters. */
	DecodingMode[DecodingMode["Attribute"] = 2] = "Attribute";
})(DecodingMode || (DecodingMode = {}));
/**
* Token decoder with support of writing partial entities.
*/
var EntityDecoder = class {
	constructor(decodeTree, emitCodePoint, errors) {
		this.decodeTree = decodeTree;
		this.emitCodePoint = emitCodePoint;
		this.errors = errors;
		/** The current state of the decoder. */
		this.state = EntityDecoderState.EntityStart;
		/** Characters that were consumed while parsing an entity. */
		this.consumed = 1;
		/**
		* The result of the entity.
		*
		* Either the result index of a numeric entity, or the codepoint of a
		* numeric entity.
		*/
		this.result = 0;
		/** The current index in the decode tree. */
		this.treeIndex = 0;
		/** The number of characters that were consumed in excess. */
		this.excess = 1;
		/** The mode in which the decoder is operating. */
		this.decodeMode = DecodingMode.Strict;
	}
	/** Resets the instance to make it reusable. */
	startEntity(decodeMode) {
		this.decodeMode = decodeMode;
		this.state = EntityDecoderState.EntityStart;
		this.result = 0;
		this.treeIndex = 0;
		this.excess = 1;
		this.consumed = 1;
	}
	/**
	* Write an entity to the decoder. This can be called multiple times with partial entities.
	* If the entity is incomplete, the decoder will return -1.
	*
	* Mirrors the implementation of `getDecoder`, but with the ability to stop decoding if the
	* entity is incomplete, and resume when the next string is written.
	*
	* @param string The string containing the entity (or a continuation of the entity).
	* @param offset The offset at which the entity begins. Should be 0 if this is not the first call.
	* @returns The number of characters that were consumed, or -1 if the entity is incomplete.
	*/
	write(str, offset) {
		switch (this.state) {
			case EntityDecoderState.EntityStart:
				if (str.charCodeAt(offset) === CharCodes.NUM) {
					this.state = EntityDecoderState.NumericStart;
					this.consumed += 1;
					return this.stateNumericStart(str, offset + 1);
				}
				this.state = EntityDecoderState.NamedEntity;
				return this.stateNamedEntity(str, offset);
			case EntityDecoderState.NumericStart: return this.stateNumericStart(str, offset);
			case EntityDecoderState.NumericDecimal: return this.stateNumericDecimal(str, offset);
			case EntityDecoderState.NumericHex: return this.stateNumericHex(str, offset);
			case EntityDecoderState.NamedEntity: return this.stateNamedEntity(str, offset);
		}
	}
	/**
	* Switches between the numeric decimal and hexadecimal states.
	*
	* Equivalent to the `Numeric character reference state` in the HTML spec.
	*
	* @param str The string containing the entity (or a continuation of the entity).
	* @param offset The current offset.
	* @returns The number of characters that were consumed, or -1 if the entity is incomplete.
	*/
	stateNumericStart(str, offset) {
		if (offset >= str.length) return -1;
		if ((str.charCodeAt(offset) | TO_LOWER_BIT) === CharCodes.LOWER_X) {
			this.state = EntityDecoderState.NumericHex;
			this.consumed += 1;
			return this.stateNumericHex(str, offset + 1);
		}
		this.state = EntityDecoderState.NumericDecimal;
		return this.stateNumericDecimal(str, offset);
	}
	addToNumericResult(str, start, end, base) {
		if (start !== end) {
			const digitCount = end - start;
			this.result = this.result * Math.pow(base, digitCount) + parseInt(str.substr(start, digitCount), base);
			this.consumed += digitCount;
		}
	}
	/**
	* Parses a hexadecimal numeric entity.
	*
	* Equivalent to the `Hexademical character reference state` in the HTML spec.
	*
	* @param str The string containing the entity (or a continuation of the entity).
	* @param offset The current offset.
	* @returns The number of characters that were consumed, or -1 if the entity is incomplete.
	*/
	stateNumericHex(str, offset) {
		const startIdx = offset;
		while (offset < str.length) {
			const char = str.charCodeAt(offset);
			if (isNumber(char) || isHexadecimalCharacter(char)) offset += 1;
			else {
				this.addToNumericResult(str, startIdx, offset, 16);
				return this.emitNumericEntity(char, 3);
			}
		}
		this.addToNumericResult(str, startIdx, offset, 16);
		return -1;
	}
	/**
	* Parses a decimal numeric entity.
	*
	* Equivalent to the `Decimal character reference state` in the HTML spec.
	*
	* @param str The string containing the entity (or a continuation of the entity).
	* @param offset The current offset.
	* @returns The number of characters that were consumed, or -1 if the entity is incomplete.
	*/
	stateNumericDecimal(str, offset) {
		const startIdx = offset;
		while (offset < str.length) {
			const char = str.charCodeAt(offset);
			if (isNumber(char)) offset += 1;
			else {
				this.addToNumericResult(str, startIdx, offset, 10);
				return this.emitNumericEntity(char, 2);
			}
		}
		this.addToNumericResult(str, startIdx, offset, 10);
		return -1;
	}
	/**
	* Validate and emit a numeric entity.
	*
	* Implements the logic from the `Hexademical character reference start
	* state` and `Numeric character reference end state` in the HTML spec.
	*
	* @param lastCp The last code point of the entity. Used to see if the
	*               entity was terminated with a semicolon.
	* @param expectedLength The minimum number of characters that should be
	*                       consumed. Used to validate that at least one digit
	*                       was consumed.
	* @returns The number of characters that were consumed.
	*/
	emitNumericEntity(lastCp, expectedLength) {
		var _a;
		if (this.consumed <= expectedLength) {
			(_a = this.errors) === null || _a === void 0 || _a.absenceOfDigitsInNumericCharacterReference(this.consumed);
			return 0;
		}
		if (lastCp === CharCodes.SEMI) this.consumed += 1;
		else if (this.decodeMode === DecodingMode.Strict) return 0;
		this.emitCodePoint(replaceCodePoint(this.result), this.consumed);
		if (this.errors) {
			if (lastCp !== CharCodes.SEMI) this.errors.missingSemicolonAfterCharacterReference();
			this.errors.validateNumericCharacterReference(this.result);
		}
		return this.consumed;
	}
	/**
	* Parses a named entity.
	*
	* Equivalent to the `Named character reference state` in the HTML spec.
	*
	* @param str The string containing the entity (or a continuation of the entity).
	* @param offset The current offset.
	* @returns The number of characters that were consumed, or -1 if the entity is incomplete.
	*/
	stateNamedEntity(str, offset) {
		const { decodeTree } = this;
		let current = decodeTree[this.treeIndex];
		let valueLength = (current & BinTrieFlags.VALUE_LENGTH) >> 14;
		for (; offset < str.length; offset++, this.excess++) {
			const char = str.charCodeAt(offset);
			this.treeIndex = determineBranch(decodeTree, current, this.treeIndex + Math.max(1, valueLength), char);
			if (this.treeIndex < 0) return this.result === 0 || this.decodeMode === DecodingMode.Attribute && (valueLength === 0 || isEntityInAttributeInvalidEnd(char)) ? 0 : this.emitNotTerminatedNamedEntity();
			current = decodeTree[this.treeIndex];
			valueLength = (current & BinTrieFlags.VALUE_LENGTH) >> 14;
			if (valueLength !== 0) {
				if (char === CharCodes.SEMI) return this.emitNamedEntityData(this.treeIndex, valueLength, this.consumed + this.excess);
				if (this.decodeMode !== DecodingMode.Strict) {
					this.result = this.treeIndex;
					this.consumed += this.excess;
					this.excess = 0;
				}
			}
		}
		return -1;
	}
	/**
	* Emit a named entity that was not terminated with a semicolon.
	*
	* @returns The number of characters consumed.
	*/
	emitNotTerminatedNamedEntity() {
		var _a;
		const { result, decodeTree } = this;
		const valueLength = (decodeTree[result] & BinTrieFlags.VALUE_LENGTH) >> 14;
		this.emitNamedEntityData(result, valueLength, this.consumed);
		(_a = this.errors) === null || _a === void 0 || _a.missingSemicolonAfterCharacterReference();
		return this.consumed;
	}
	/**
	* Emit a named entity.
	*
	* @param result The index of the entity in the decode tree.
	* @param valueLength The number of bytes in the entity.
	* @param consumed The number of characters consumed.
	*
	* @returns The number of characters consumed.
	*/
	emitNamedEntityData(result, valueLength, consumed) {
		const { decodeTree } = this;
		this.emitCodePoint(valueLength === 1 ? decodeTree[result] & ~BinTrieFlags.VALUE_LENGTH : decodeTree[result + 1], consumed);
		if (valueLength === 3) this.emitCodePoint(decodeTree[result + 2], consumed);
		return consumed;
	}
	/**
	* Signal to the parser that the end of the input was reached.
	*
	* Remaining data will be emitted and relevant errors will be produced.
	*
	* @returns The number of characters consumed.
	*/
	end() {
		var _a;
		switch (this.state) {
			case EntityDecoderState.NamedEntity: return this.result !== 0 && (this.decodeMode !== DecodingMode.Attribute || this.result === this.treeIndex) ? this.emitNotTerminatedNamedEntity() : 0;
			case EntityDecoderState.NumericDecimal: return this.emitNumericEntity(0, 2);
			case EntityDecoderState.NumericHex: return this.emitNumericEntity(0, 3);
			case EntityDecoderState.NumericStart:
				(_a = this.errors) === null || _a === void 0 || _a.absenceOfDigitsInNumericCharacterReference(this.consumed);
				return 0;
			case EntityDecoderState.EntityStart: return 0;
		}
	}
};
/**
* Creates a function that decodes entities in a string.
*
* @param decodeTree The decode tree.
* @returns A function that decodes entities in a string.
*/
function getDecoder(decodeTree) {
	let ret = "";
	const decoder = new EntityDecoder(decodeTree, (str) => ret += fromCodePoint$1(str));
	return function decodeWithTrie(str, decodeMode) {
		let lastIndex = 0;
		let offset = 0;
		while ((offset = str.indexOf("&", offset)) >= 0) {
			ret += str.slice(lastIndex, offset);
			decoder.startEntity(decodeMode);
			const len = decoder.write(str, offset + 1);
			if (len < 0) {
				lastIndex = offset + decoder.end();
				break;
			}
			lastIndex = offset + len;
			offset = len === 0 ? lastIndex + 1 : lastIndex;
		}
		const result = ret + str.slice(lastIndex);
		ret = "";
		return result;
	};
}
/**
* Determines the branch of the current node that is taken given the current
* character. This function is used to traverse the trie.
*
* @param decodeTree The trie.
* @param current The current node.
* @param nodeIdx The index right after the current node and its value.
* @param char The current character.
* @returns The index of the next node, or -1 if no branch is taken.
*/
function determineBranch(decodeTree, current, nodeIdx, char) {
	const branchCount = (current & BinTrieFlags.BRANCH_LENGTH) >> 7;
	const jumpOffset = current & BinTrieFlags.JUMP_TABLE;
	if (branchCount === 0) return jumpOffset !== 0 && char === jumpOffset ? nodeIdx : -1;
	if (jumpOffset) {
		const value = char - jumpOffset;
		return value < 0 || value >= branchCount ? -1 : decodeTree[nodeIdx + value] - 1;
	}
	let lo = nodeIdx;
	let hi = lo + branchCount - 1;
	while (lo <= hi) {
		const mid = lo + hi >>> 1;
		const midVal = decodeTree[mid];
		if (midVal < char) lo = mid + 1;
		else if (midVal > char) hi = mid - 1;
		else return decodeTree[mid + branchCount];
	}
	return -1;
}
const htmlDecoder = getDecoder(decode_data_html_default);
getDecoder(decode_data_xml_default);
/**
* Decodes an HTML string.
*
* @param str The string to decode.
* @param mode The decoding mode.
* @returns The decoded string.
*/
function decodeHTML(str, mode = DecodingMode.Legacy) {
	return htmlDecoder(str, mode);
}
function restoreDiff(arr) {
	for (let i = 1; i < arr.length; i++) arr[i][0] += arr[i - 1][0] + 1;
	return arr;
}
new Map(/* @__PURE__ */ restoreDiff([
	[9, "&Tab;"],
	[0, "&NewLine;"],
	[22, "&excl;"],
	[0, "&quot;"],
	[0, "&num;"],
	[0, "&dollar;"],
	[0, "&percnt;"],
	[0, "&amp;"],
	[0, "&apos;"],
	[0, "&lpar;"],
	[0, "&rpar;"],
	[0, "&ast;"],
	[0, "&plus;"],
	[0, "&comma;"],
	[1, "&period;"],
	[0, "&sol;"],
	[10, "&colon;"],
	[0, "&semi;"],
	[0, {
		v: "&lt;",
		n: 8402,
		o: "&nvlt;"
	}],
	[0, {
		v: "&equals;",
		n: 8421,
		o: "&bne;"
	}],
	[0, {
		v: "&gt;",
		n: 8402,
		o: "&nvgt;"
	}],
	[0, "&quest;"],
	[0, "&commat;"],
	[26, "&lbrack;"],
	[0, "&bsol;"],
	[0, "&rbrack;"],
	[0, "&Hat;"],
	[0, "&lowbar;"],
	[0, "&DiacriticalGrave;"],
	[5, {
		n: 106,
		o: "&fjlig;"
	}],
	[20, "&lbrace;"],
	[0, "&verbar;"],
	[0, "&rbrace;"],
	[34, "&nbsp;"],
	[0, "&iexcl;"],
	[0, "&cent;"],
	[0, "&pound;"],
	[0, "&curren;"],
	[0, "&yen;"],
	[0, "&brvbar;"],
	[0, "&sect;"],
	[0, "&die;"],
	[0, "&copy;"],
	[0, "&ordf;"],
	[0, "&laquo;"],
	[0, "&not;"],
	[0, "&shy;"],
	[0, "&circledR;"],
	[0, "&macr;"],
	[0, "&deg;"],
	[0, "&PlusMinus;"],
	[0, "&sup2;"],
	[0, "&sup3;"],
	[0, "&acute;"],
	[0, "&micro;"],
	[0, "&para;"],
	[0, "&centerdot;"],
	[0, "&cedil;"],
	[0, "&sup1;"],
	[0, "&ordm;"],
	[0, "&raquo;"],
	[0, "&frac14;"],
	[0, "&frac12;"],
	[0, "&frac34;"],
	[0, "&iquest;"],
	[0, "&Agrave;"],
	[0, "&Aacute;"],
	[0, "&Acirc;"],
	[0, "&Atilde;"],
	[0, "&Auml;"],
	[0, "&angst;"],
	[0, "&AElig;"],
	[0, "&Ccedil;"],
	[0, "&Egrave;"],
	[0, "&Eacute;"],
	[0, "&Ecirc;"],
	[0, "&Euml;"],
	[0, "&Igrave;"],
	[0, "&Iacute;"],
	[0, "&Icirc;"],
	[0, "&Iuml;"],
	[0, "&ETH;"],
	[0, "&Ntilde;"],
	[0, "&Ograve;"],
	[0, "&Oacute;"],
	[0, "&Ocirc;"],
	[0, "&Otilde;"],
	[0, "&Ouml;"],
	[0, "&times;"],
	[0, "&Oslash;"],
	[0, "&Ugrave;"],
	[0, "&Uacute;"],
	[0, "&Ucirc;"],
	[0, "&Uuml;"],
	[0, "&Yacute;"],
	[0, "&THORN;"],
	[0, "&szlig;"],
	[0, "&agrave;"],
	[0, "&aacute;"],
	[0, "&acirc;"],
	[0, "&atilde;"],
	[0, "&auml;"],
	[0, "&aring;"],
	[0, "&aelig;"],
	[0, "&ccedil;"],
	[0, "&egrave;"],
	[0, "&eacute;"],
	[0, "&ecirc;"],
	[0, "&euml;"],
	[0, "&igrave;"],
	[0, "&iacute;"],
	[0, "&icirc;"],
	[0, "&iuml;"],
	[0, "&eth;"],
	[0, "&ntilde;"],
	[0, "&ograve;"],
	[0, "&oacute;"],
	[0, "&ocirc;"],
	[0, "&otilde;"],
	[0, "&ouml;"],
	[0, "&div;"],
	[0, "&oslash;"],
	[0, "&ugrave;"],
	[0, "&uacute;"],
	[0, "&ucirc;"],
	[0, "&uuml;"],
	[0, "&yacute;"],
	[0, "&thorn;"],
	[0, "&yuml;"],
	[0, "&Amacr;"],
	[0, "&amacr;"],
	[0, "&Abreve;"],
	[0, "&abreve;"],
	[0, "&Aogon;"],
	[0, "&aogon;"],
	[0, "&Cacute;"],
	[0, "&cacute;"],
	[0, "&Ccirc;"],
	[0, "&ccirc;"],
	[0, "&Cdot;"],
	[0, "&cdot;"],
	[0, "&Ccaron;"],
	[0, "&ccaron;"],
	[0, "&Dcaron;"],
	[0, "&dcaron;"],
	[0, "&Dstrok;"],
	[0, "&dstrok;"],
	[0, "&Emacr;"],
	[0, "&emacr;"],
	[2, "&Edot;"],
	[0, "&edot;"],
	[0, "&Eogon;"],
	[0, "&eogon;"],
	[0, "&Ecaron;"],
	[0, "&ecaron;"],
	[0, "&Gcirc;"],
	[0, "&gcirc;"],
	[0, "&Gbreve;"],
	[0, "&gbreve;"],
	[0, "&Gdot;"],
	[0, "&gdot;"],
	[0, "&Gcedil;"],
	[1, "&Hcirc;"],
	[0, "&hcirc;"],
	[0, "&Hstrok;"],
	[0, "&hstrok;"],
	[0, "&Itilde;"],
	[0, "&itilde;"],
	[0, "&Imacr;"],
	[0, "&imacr;"],
	[2, "&Iogon;"],
	[0, "&iogon;"],
	[0, "&Idot;"],
	[0, "&imath;"],
	[0, "&IJlig;"],
	[0, "&ijlig;"],
	[0, "&Jcirc;"],
	[0, "&jcirc;"],
	[0, "&Kcedil;"],
	[0, "&kcedil;"],
	[0, "&kgreen;"],
	[0, "&Lacute;"],
	[0, "&lacute;"],
	[0, "&Lcedil;"],
	[0, "&lcedil;"],
	[0, "&Lcaron;"],
	[0, "&lcaron;"],
	[0, "&Lmidot;"],
	[0, "&lmidot;"],
	[0, "&Lstrok;"],
	[0, "&lstrok;"],
	[0, "&Nacute;"],
	[0, "&nacute;"],
	[0, "&Ncedil;"],
	[0, "&ncedil;"],
	[0, "&Ncaron;"],
	[0, "&ncaron;"],
	[0, "&napos;"],
	[0, "&ENG;"],
	[0, "&eng;"],
	[0, "&Omacr;"],
	[0, "&omacr;"],
	[2, "&Odblac;"],
	[0, "&odblac;"],
	[0, "&OElig;"],
	[0, "&oelig;"],
	[0, "&Racute;"],
	[0, "&racute;"],
	[0, "&Rcedil;"],
	[0, "&rcedil;"],
	[0, "&Rcaron;"],
	[0, "&rcaron;"],
	[0, "&Sacute;"],
	[0, "&sacute;"],
	[0, "&Scirc;"],
	[0, "&scirc;"],
	[0, "&Scedil;"],
	[0, "&scedil;"],
	[0, "&Scaron;"],
	[0, "&scaron;"],
	[0, "&Tcedil;"],
	[0, "&tcedil;"],
	[0, "&Tcaron;"],
	[0, "&tcaron;"],
	[0, "&Tstrok;"],
	[0, "&tstrok;"],
	[0, "&Utilde;"],
	[0, "&utilde;"],
	[0, "&Umacr;"],
	[0, "&umacr;"],
	[0, "&Ubreve;"],
	[0, "&ubreve;"],
	[0, "&Uring;"],
	[0, "&uring;"],
	[0, "&Udblac;"],
	[0, "&udblac;"],
	[0, "&Uogon;"],
	[0, "&uogon;"],
	[0, "&Wcirc;"],
	[0, "&wcirc;"],
	[0, "&Ycirc;"],
	[0, "&ycirc;"],
	[0, "&Yuml;"],
	[0, "&Zacute;"],
	[0, "&zacute;"],
	[0, "&Zdot;"],
	[0, "&zdot;"],
	[0, "&Zcaron;"],
	[0, "&zcaron;"],
	[19, "&fnof;"],
	[34, "&imped;"],
	[63, "&gacute;"],
	[65, "&jmath;"],
	[142, "&circ;"],
	[0, "&caron;"],
	[16, "&breve;"],
	[0, "&DiacriticalDot;"],
	[0, "&ring;"],
	[0, "&ogon;"],
	[0, "&DiacriticalTilde;"],
	[0, "&dblac;"],
	[51, "&DownBreve;"],
	[127, "&Alpha;"],
	[0, "&Beta;"],
	[0, "&Gamma;"],
	[0, "&Delta;"],
	[0, "&Epsilon;"],
	[0, "&Zeta;"],
	[0, "&Eta;"],
	[0, "&Theta;"],
	[0, "&Iota;"],
	[0, "&Kappa;"],
	[0, "&Lambda;"],
	[0, "&Mu;"],
	[0, "&Nu;"],
	[0, "&Xi;"],
	[0, "&Omicron;"],
	[0, "&Pi;"],
	[0, "&Rho;"],
	[1, "&Sigma;"],
	[0, "&Tau;"],
	[0, "&Upsilon;"],
	[0, "&Phi;"],
	[0, "&Chi;"],
	[0, "&Psi;"],
	[0, "&ohm;"],
	[7, "&alpha;"],
	[0, "&beta;"],
	[0, "&gamma;"],
	[0, "&delta;"],
	[0, "&epsi;"],
	[0, "&zeta;"],
	[0, "&eta;"],
	[0, "&theta;"],
	[0, "&iota;"],
	[0, "&kappa;"],
	[0, "&lambda;"],
	[0, "&mu;"],
	[0, "&nu;"],
	[0, "&xi;"],
	[0, "&omicron;"],
	[0, "&pi;"],
	[0, "&rho;"],
	[0, "&sigmaf;"],
	[0, "&sigma;"],
	[0, "&tau;"],
	[0, "&upsi;"],
	[0, "&phi;"],
	[0, "&chi;"],
	[0, "&psi;"],
	[0, "&omega;"],
	[7, "&thetasym;"],
	[0, "&Upsi;"],
	[2, "&phiv;"],
	[0, "&piv;"],
	[5, "&Gammad;"],
	[0, "&digamma;"],
	[18, "&kappav;"],
	[0, "&rhov;"],
	[3, "&epsiv;"],
	[0, "&backepsilon;"],
	[10, "&IOcy;"],
	[0, "&DJcy;"],
	[0, "&GJcy;"],
	[0, "&Jukcy;"],
	[0, "&DScy;"],
	[0, "&Iukcy;"],
	[0, "&YIcy;"],
	[0, "&Jsercy;"],
	[0, "&LJcy;"],
	[0, "&NJcy;"],
	[0, "&TSHcy;"],
	[0, "&KJcy;"],
	[1, "&Ubrcy;"],
	[0, "&DZcy;"],
	[0, "&Acy;"],
	[0, "&Bcy;"],
	[0, "&Vcy;"],
	[0, "&Gcy;"],
	[0, "&Dcy;"],
	[0, "&IEcy;"],
	[0, "&ZHcy;"],
	[0, "&Zcy;"],
	[0, "&Icy;"],
	[0, "&Jcy;"],
	[0, "&Kcy;"],
	[0, "&Lcy;"],
	[0, "&Mcy;"],
	[0, "&Ncy;"],
	[0, "&Ocy;"],
	[0, "&Pcy;"],
	[0, "&Rcy;"],
	[0, "&Scy;"],
	[0, "&Tcy;"],
	[0, "&Ucy;"],
	[0, "&Fcy;"],
	[0, "&KHcy;"],
	[0, "&TScy;"],
	[0, "&CHcy;"],
	[0, "&SHcy;"],
	[0, "&SHCHcy;"],
	[0, "&HARDcy;"],
	[0, "&Ycy;"],
	[0, "&SOFTcy;"],
	[0, "&Ecy;"],
	[0, "&YUcy;"],
	[0, "&YAcy;"],
	[0, "&acy;"],
	[0, "&bcy;"],
	[0, "&vcy;"],
	[0, "&gcy;"],
	[0, "&dcy;"],
	[0, "&iecy;"],
	[0, "&zhcy;"],
	[0, "&zcy;"],
	[0, "&icy;"],
	[0, "&jcy;"],
	[0, "&kcy;"],
	[0, "&lcy;"],
	[0, "&mcy;"],
	[0, "&ncy;"],
	[0, "&ocy;"],
	[0, "&pcy;"],
	[0, "&rcy;"],
	[0, "&scy;"],
	[0, "&tcy;"],
	[0, "&ucy;"],
	[0, "&fcy;"],
	[0, "&khcy;"],
	[0, "&tscy;"],
	[0, "&chcy;"],
	[0, "&shcy;"],
	[0, "&shchcy;"],
	[0, "&hardcy;"],
	[0, "&ycy;"],
	[0, "&softcy;"],
	[0, "&ecy;"],
	[0, "&yucy;"],
	[0, "&yacy;"],
	[1, "&iocy;"],
	[0, "&djcy;"],
	[0, "&gjcy;"],
	[0, "&jukcy;"],
	[0, "&dscy;"],
	[0, "&iukcy;"],
	[0, "&yicy;"],
	[0, "&jsercy;"],
	[0, "&ljcy;"],
	[0, "&njcy;"],
	[0, "&tshcy;"],
	[0, "&kjcy;"],
	[1, "&ubrcy;"],
	[0, "&dzcy;"],
	[7074, "&ensp;"],
	[0, "&emsp;"],
	[0, "&emsp13;"],
	[0, "&emsp14;"],
	[1, "&numsp;"],
	[0, "&puncsp;"],
	[0, "&ThinSpace;"],
	[0, "&hairsp;"],
	[0, "&NegativeMediumSpace;"],
	[0, "&zwnj;"],
	[0, "&zwj;"],
	[0, "&lrm;"],
	[0, "&rlm;"],
	[0, "&dash;"],
	[2, "&ndash;"],
	[0, "&mdash;"],
	[0, "&horbar;"],
	[0, "&Verbar;"],
	[1, "&lsquo;"],
	[0, "&CloseCurlyQuote;"],
	[0, "&lsquor;"],
	[1, "&ldquo;"],
	[0, "&CloseCurlyDoubleQuote;"],
	[0, "&bdquo;"],
	[1, "&dagger;"],
	[0, "&Dagger;"],
	[0, "&bull;"],
	[2, "&nldr;"],
	[0, "&hellip;"],
	[9, "&permil;"],
	[0, "&pertenk;"],
	[0, "&prime;"],
	[0, "&Prime;"],
	[0, "&tprime;"],
	[0, "&backprime;"],
	[3, "&lsaquo;"],
	[0, "&rsaquo;"],
	[3, "&oline;"],
	[2, "&caret;"],
	[1, "&hybull;"],
	[0, "&frasl;"],
	[10, "&bsemi;"],
	[7, "&qprime;"],
	[7, {
		v: "&MediumSpace;",
		n: 8202,
		o: "&ThickSpace;"
	}],
	[0, "&NoBreak;"],
	[0, "&af;"],
	[0, "&InvisibleTimes;"],
	[0, "&ic;"],
	[72, "&euro;"],
	[46, "&tdot;"],
	[0, "&DotDot;"],
	[37, "&complexes;"],
	[2, "&incare;"],
	[4, "&gscr;"],
	[0, "&hamilt;"],
	[0, "&Hfr;"],
	[0, "&Hopf;"],
	[0, "&planckh;"],
	[0, "&hbar;"],
	[0, "&imagline;"],
	[0, "&Ifr;"],
	[0, "&lagran;"],
	[0, "&ell;"],
	[1, "&naturals;"],
	[0, "&numero;"],
	[0, "&copysr;"],
	[0, "&weierp;"],
	[0, "&Popf;"],
	[0, "&Qopf;"],
	[0, "&realine;"],
	[0, "&real;"],
	[0, "&reals;"],
	[0, "&rx;"],
	[3, "&trade;"],
	[1, "&integers;"],
	[2, "&mho;"],
	[0, "&zeetrf;"],
	[0, "&iiota;"],
	[2, "&bernou;"],
	[0, "&Cayleys;"],
	[1, "&escr;"],
	[0, "&Escr;"],
	[0, "&Fouriertrf;"],
	[1, "&Mellintrf;"],
	[0, "&order;"],
	[0, "&alefsym;"],
	[0, "&beth;"],
	[0, "&gimel;"],
	[0, "&daleth;"],
	[12, "&CapitalDifferentialD;"],
	[0, "&dd;"],
	[0, "&ee;"],
	[0, "&ii;"],
	[10, "&frac13;"],
	[0, "&frac23;"],
	[0, "&frac15;"],
	[0, "&frac25;"],
	[0, "&frac35;"],
	[0, "&frac45;"],
	[0, "&frac16;"],
	[0, "&frac56;"],
	[0, "&frac18;"],
	[0, "&frac38;"],
	[0, "&frac58;"],
	[0, "&frac78;"],
	[49, "&larr;"],
	[0, "&ShortUpArrow;"],
	[0, "&rarr;"],
	[0, "&darr;"],
	[0, "&harr;"],
	[0, "&updownarrow;"],
	[0, "&nwarr;"],
	[0, "&nearr;"],
	[0, "&LowerRightArrow;"],
	[0, "&LowerLeftArrow;"],
	[0, "&nlarr;"],
	[0, "&nrarr;"],
	[1, {
		v: "&rarrw;",
		n: 824,
		o: "&nrarrw;"
	}],
	[0, "&Larr;"],
	[0, "&Uarr;"],
	[0, "&Rarr;"],
	[0, "&Darr;"],
	[0, "&larrtl;"],
	[0, "&rarrtl;"],
	[0, "&LeftTeeArrow;"],
	[0, "&mapstoup;"],
	[0, "&map;"],
	[0, "&DownTeeArrow;"],
	[1, "&hookleftarrow;"],
	[0, "&hookrightarrow;"],
	[0, "&larrlp;"],
	[0, "&looparrowright;"],
	[0, "&harrw;"],
	[0, "&nharr;"],
	[1, "&lsh;"],
	[0, "&rsh;"],
	[0, "&ldsh;"],
	[0, "&rdsh;"],
	[1, "&crarr;"],
	[0, "&cularr;"],
	[0, "&curarr;"],
	[2, "&circlearrowleft;"],
	[0, "&circlearrowright;"],
	[0, "&leftharpoonup;"],
	[0, "&DownLeftVector;"],
	[0, "&RightUpVector;"],
	[0, "&LeftUpVector;"],
	[0, "&rharu;"],
	[0, "&DownRightVector;"],
	[0, "&dharr;"],
	[0, "&dharl;"],
	[0, "&RightArrowLeftArrow;"],
	[0, "&udarr;"],
	[0, "&LeftArrowRightArrow;"],
	[0, "&leftleftarrows;"],
	[0, "&upuparrows;"],
	[0, "&rightrightarrows;"],
	[0, "&ddarr;"],
	[0, "&leftrightharpoons;"],
	[0, "&Equilibrium;"],
	[0, "&nlArr;"],
	[0, "&nhArr;"],
	[0, "&nrArr;"],
	[0, "&DoubleLeftArrow;"],
	[0, "&DoubleUpArrow;"],
	[0, "&DoubleRightArrow;"],
	[0, "&dArr;"],
	[0, "&DoubleLeftRightArrow;"],
	[0, "&DoubleUpDownArrow;"],
	[0, "&nwArr;"],
	[0, "&neArr;"],
	[0, "&seArr;"],
	[0, "&swArr;"],
	[0, "&lAarr;"],
	[0, "&rAarr;"],
	[1, "&zigrarr;"],
	[6, "&larrb;"],
	[0, "&rarrb;"],
	[15, "&DownArrowUpArrow;"],
	[7, "&loarr;"],
	[0, "&roarr;"],
	[0, "&hoarr;"],
	[0, "&forall;"],
	[0, "&comp;"],
	[0, {
		v: "&part;",
		n: 824,
		o: "&npart;"
	}],
	[0, "&exist;"],
	[0, "&nexist;"],
	[0, "&empty;"],
	[1, "&Del;"],
	[0, "&Element;"],
	[0, "&NotElement;"],
	[1, "&ni;"],
	[0, "&notni;"],
	[2, "&prod;"],
	[0, "&coprod;"],
	[0, "&sum;"],
	[0, "&minus;"],
	[0, "&MinusPlus;"],
	[0, "&dotplus;"],
	[1, "&Backslash;"],
	[0, "&lowast;"],
	[0, "&compfn;"],
	[1, "&radic;"],
	[2, "&prop;"],
	[0, "&infin;"],
	[0, "&angrt;"],
	[0, {
		v: "&ang;",
		n: 8402,
		o: "&nang;"
	}],
	[0, "&angmsd;"],
	[0, "&angsph;"],
	[0, "&mid;"],
	[0, "&nmid;"],
	[0, "&DoubleVerticalBar;"],
	[0, "&NotDoubleVerticalBar;"],
	[0, "&and;"],
	[0, "&or;"],
	[0, {
		v: "&cap;",
		n: 65024,
		o: "&caps;"
	}],
	[0, {
		v: "&cup;",
		n: 65024,
		o: "&cups;"
	}],
	[0, "&int;"],
	[0, "&Int;"],
	[0, "&iiint;"],
	[0, "&conint;"],
	[0, "&Conint;"],
	[0, "&Cconint;"],
	[0, "&cwint;"],
	[0, "&ClockwiseContourIntegral;"],
	[0, "&awconint;"],
	[0, "&there4;"],
	[0, "&becaus;"],
	[0, "&ratio;"],
	[0, "&Colon;"],
	[0, "&dotminus;"],
	[1, "&mDDot;"],
	[0, "&homtht;"],
	[0, {
		v: "&sim;",
		n: 8402,
		o: "&nvsim;"
	}],
	[0, {
		v: "&backsim;",
		n: 817,
		o: "&race;"
	}],
	[0, {
		v: "&ac;",
		n: 819,
		o: "&acE;"
	}],
	[0, "&acd;"],
	[0, "&VerticalTilde;"],
	[0, "&NotTilde;"],
	[0, {
		v: "&eqsim;",
		n: 824,
		o: "&nesim;"
	}],
	[0, "&sime;"],
	[0, "&NotTildeEqual;"],
	[0, "&cong;"],
	[0, "&simne;"],
	[0, "&ncong;"],
	[0, "&ap;"],
	[0, "&nap;"],
	[0, "&ape;"],
	[0, {
		v: "&apid;",
		n: 824,
		o: "&napid;"
	}],
	[0, "&backcong;"],
	[0, {
		v: "&asympeq;",
		n: 8402,
		o: "&nvap;"
	}],
	[0, {
		v: "&bump;",
		n: 824,
		o: "&nbump;"
	}],
	[0, {
		v: "&bumpe;",
		n: 824,
		o: "&nbumpe;"
	}],
	[0, {
		v: "&doteq;",
		n: 824,
		o: "&nedot;"
	}],
	[0, "&doteqdot;"],
	[0, "&efDot;"],
	[0, "&erDot;"],
	[0, "&Assign;"],
	[0, "&ecolon;"],
	[0, "&ecir;"],
	[0, "&circeq;"],
	[1, "&wedgeq;"],
	[0, "&veeeq;"],
	[1, "&triangleq;"],
	[2, "&equest;"],
	[0, "&ne;"],
	[0, {
		v: "&Congruent;",
		n: 8421,
		o: "&bnequiv;"
	}],
	[0, "&nequiv;"],
	[1, {
		v: "&le;",
		n: 8402,
		o: "&nvle;"
	}],
	[0, {
		v: "&ge;",
		n: 8402,
		o: "&nvge;"
	}],
	[0, {
		v: "&lE;",
		n: 824,
		o: "&nlE;"
	}],
	[0, {
		v: "&gE;",
		n: 824,
		o: "&ngE;"
	}],
	[0, {
		v: "&lnE;",
		n: 65024,
		o: "&lvertneqq;"
	}],
	[0, {
		v: "&gnE;",
		n: 65024,
		o: "&gvertneqq;"
	}],
	[0, {
		v: "&ll;",
		n: new Map(/* @__PURE__ */ restoreDiff([[824, "&nLtv;"], [7577, "&nLt;"]]))
	}],
	[0, {
		v: "&gg;",
		n: new Map(/* @__PURE__ */ restoreDiff([[824, "&nGtv;"], [7577, "&nGt;"]]))
	}],
	[0, "&between;"],
	[0, "&NotCupCap;"],
	[0, "&nless;"],
	[0, "&ngt;"],
	[0, "&nle;"],
	[0, "&nge;"],
	[0, "&lesssim;"],
	[0, "&GreaterTilde;"],
	[0, "&nlsim;"],
	[0, "&ngsim;"],
	[0, "&LessGreater;"],
	[0, "&gl;"],
	[0, "&NotLessGreater;"],
	[0, "&NotGreaterLess;"],
	[0, "&pr;"],
	[0, "&sc;"],
	[0, "&prcue;"],
	[0, "&sccue;"],
	[0, "&PrecedesTilde;"],
	[0, {
		v: "&scsim;",
		n: 824,
		o: "&NotSucceedsTilde;"
	}],
	[0, "&NotPrecedes;"],
	[0, "&NotSucceeds;"],
	[0, {
		v: "&sub;",
		n: 8402,
		o: "&NotSubset;"
	}],
	[0, {
		v: "&sup;",
		n: 8402,
		o: "&NotSuperset;"
	}],
	[0, "&nsub;"],
	[0, "&nsup;"],
	[0, "&sube;"],
	[0, "&supe;"],
	[0, "&NotSubsetEqual;"],
	[0, "&NotSupersetEqual;"],
	[0, {
		v: "&subne;",
		n: 65024,
		o: "&varsubsetneq;"
	}],
	[0, {
		v: "&supne;",
		n: 65024,
		o: "&varsupsetneq;"
	}],
	[1, "&cupdot;"],
	[0, "&UnionPlus;"],
	[0, {
		v: "&sqsub;",
		n: 824,
		o: "&NotSquareSubset;"
	}],
	[0, {
		v: "&sqsup;",
		n: 824,
		o: "&NotSquareSuperset;"
	}],
	[0, "&sqsube;"],
	[0, "&sqsupe;"],
	[0, {
		v: "&sqcap;",
		n: 65024,
		o: "&sqcaps;"
	}],
	[0, {
		v: "&sqcup;",
		n: 65024,
		o: "&sqcups;"
	}],
	[0, "&CirclePlus;"],
	[0, "&CircleMinus;"],
	[0, "&CircleTimes;"],
	[0, "&osol;"],
	[0, "&CircleDot;"],
	[0, "&circledcirc;"],
	[0, "&circledast;"],
	[1, "&circleddash;"],
	[0, "&boxplus;"],
	[0, "&boxminus;"],
	[0, "&boxtimes;"],
	[0, "&dotsquare;"],
	[0, "&RightTee;"],
	[0, "&dashv;"],
	[0, "&DownTee;"],
	[0, "&bot;"],
	[1, "&models;"],
	[0, "&DoubleRightTee;"],
	[0, "&Vdash;"],
	[0, "&Vvdash;"],
	[0, "&VDash;"],
	[0, "&nvdash;"],
	[0, "&nvDash;"],
	[0, "&nVdash;"],
	[0, "&nVDash;"],
	[0, "&prurel;"],
	[1, "&LeftTriangle;"],
	[0, "&RightTriangle;"],
	[0, {
		v: "&LeftTriangleEqual;",
		n: 8402,
		o: "&nvltrie;"
	}],
	[0, {
		v: "&RightTriangleEqual;",
		n: 8402,
		o: "&nvrtrie;"
	}],
	[0, "&origof;"],
	[0, "&imof;"],
	[0, "&multimap;"],
	[0, "&hercon;"],
	[0, "&intcal;"],
	[0, "&veebar;"],
	[1, "&barvee;"],
	[0, "&angrtvb;"],
	[0, "&lrtri;"],
	[0, "&bigwedge;"],
	[0, "&bigvee;"],
	[0, "&bigcap;"],
	[0, "&bigcup;"],
	[0, "&diam;"],
	[0, "&sdot;"],
	[0, "&sstarf;"],
	[0, "&divideontimes;"],
	[0, "&bowtie;"],
	[0, "&ltimes;"],
	[0, "&rtimes;"],
	[0, "&leftthreetimes;"],
	[0, "&rightthreetimes;"],
	[0, "&backsimeq;"],
	[0, "&curlyvee;"],
	[0, "&curlywedge;"],
	[0, "&Sub;"],
	[0, "&Sup;"],
	[0, "&Cap;"],
	[0, "&Cup;"],
	[0, "&fork;"],
	[0, "&epar;"],
	[0, "&lessdot;"],
	[0, "&gtdot;"],
	[0, {
		v: "&Ll;",
		n: 824,
		o: "&nLl;"
	}],
	[0, {
		v: "&Gg;",
		n: 824,
		o: "&nGg;"
	}],
	[0, {
		v: "&leg;",
		n: 65024,
		o: "&lesg;"
	}],
	[0, {
		v: "&gel;",
		n: 65024,
		o: "&gesl;"
	}],
	[2, "&cuepr;"],
	[0, "&cuesc;"],
	[0, "&NotPrecedesSlantEqual;"],
	[0, "&NotSucceedsSlantEqual;"],
	[0, "&NotSquareSubsetEqual;"],
	[0, "&NotSquareSupersetEqual;"],
	[2, "&lnsim;"],
	[0, "&gnsim;"],
	[0, "&precnsim;"],
	[0, "&scnsim;"],
	[0, "&nltri;"],
	[0, "&NotRightTriangle;"],
	[0, "&nltrie;"],
	[0, "&NotRightTriangleEqual;"],
	[0, "&vellip;"],
	[0, "&ctdot;"],
	[0, "&utdot;"],
	[0, "&dtdot;"],
	[0, "&disin;"],
	[0, "&isinsv;"],
	[0, "&isins;"],
	[0, {
		v: "&isindot;",
		n: 824,
		o: "&notindot;"
	}],
	[0, "&notinvc;"],
	[0, "&notinvb;"],
	[1, {
		v: "&isinE;",
		n: 824,
		o: "&notinE;"
	}],
	[0, "&nisd;"],
	[0, "&xnis;"],
	[0, "&nis;"],
	[0, "&notnivc;"],
	[0, "&notnivb;"],
	[6, "&barwed;"],
	[0, "&Barwed;"],
	[1, "&lceil;"],
	[0, "&rceil;"],
	[0, "&LeftFloor;"],
	[0, "&rfloor;"],
	[0, "&drcrop;"],
	[0, "&dlcrop;"],
	[0, "&urcrop;"],
	[0, "&ulcrop;"],
	[0, "&bnot;"],
	[1, "&profline;"],
	[0, "&profsurf;"],
	[1, "&telrec;"],
	[0, "&target;"],
	[5, "&ulcorn;"],
	[0, "&urcorn;"],
	[0, "&dlcorn;"],
	[0, "&drcorn;"],
	[2, "&frown;"],
	[0, "&smile;"],
	[9, "&cylcty;"],
	[0, "&profalar;"],
	[7, "&topbot;"],
	[6, "&ovbar;"],
	[1, "&solbar;"],
	[60, "&angzarr;"],
	[51, "&lmoustache;"],
	[0, "&rmoustache;"],
	[2, "&OverBracket;"],
	[0, "&bbrk;"],
	[0, "&bbrktbrk;"],
	[37, "&OverParenthesis;"],
	[0, "&UnderParenthesis;"],
	[0, "&OverBrace;"],
	[0, "&UnderBrace;"],
	[2, "&trpezium;"],
	[4, "&elinters;"],
	[59, "&blank;"],
	[164, "&circledS;"],
	[55, "&boxh;"],
	[1, "&boxv;"],
	[9, "&boxdr;"],
	[3, "&boxdl;"],
	[3, "&boxur;"],
	[3, "&boxul;"],
	[3, "&boxvr;"],
	[7, "&boxvl;"],
	[7, "&boxhd;"],
	[7, "&boxhu;"],
	[7, "&boxvh;"],
	[19, "&boxH;"],
	[0, "&boxV;"],
	[0, "&boxdR;"],
	[0, "&boxDr;"],
	[0, "&boxDR;"],
	[0, "&boxdL;"],
	[0, "&boxDl;"],
	[0, "&boxDL;"],
	[0, "&boxuR;"],
	[0, "&boxUr;"],
	[0, "&boxUR;"],
	[0, "&boxuL;"],
	[0, "&boxUl;"],
	[0, "&boxUL;"],
	[0, "&boxvR;"],
	[0, "&boxVr;"],
	[0, "&boxVR;"],
	[0, "&boxvL;"],
	[0, "&boxVl;"],
	[0, "&boxVL;"],
	[0, "&boxHd;"],
	[0, "&boxhD;"],
	[0, "&boxHD;"],
	[0, "&boxHu;"],
	[0, "&boxhU;"],
	[0, "&boxHU;"],
	[0, "&boxvH;"],
	[0, "&boxVh;"],
	[0, "&boxVH;"],
	[19, "&uhblk;"],
	[3, "&lhblk;"],
	[3, "&block;"],
	[8, "&blk14;"],
	[0, "&blk12;"],
	[0, "&blk34;"],
	[13, "&square;"],
	[8, "&blacksquare;"],
	[0, "&EmptyVerySmallSquare;"],
	[1, "&rect;"],
	[0, "&marker;"],
	[2, "&fltns;"],
	[1, "&bigtriangleup;"],
	[0, "&blacktriangle;"],
	[0, "&triangle;"],
	[2, "&blacktriangleright;"],
	[0, "&rtri;"],
	[3, "&bigtriangledown;"],
	[0, "&blacktriangledown;"],
	[0, "&dtri;"],
	[2, "&blacktriangleleft;"],
	[0, "&ltri;"],
	[6, "&loz;"],
	[0, "&cir;"],
	[32, "&tridot;"],
	[2, "&bigcirc;"],
	[8, "&ultri;"],
	[0, "&urtri;"],
	[0, "&lltri;"],
	[0, "&EmptySmallSquare;"],
	[0, "&FilledSmallSquare;"],
	[8, "&bigstar;"],
	[0, "&star;"],
	[7, "&phone;"],
	[49, "&female;"],
	[1, "&male;"],
	[29, "&spades;"],
	[2, "&clubs;"],
	[1, "&hearts;"],
	[0, "&diamondsuit;"],
	[3, "&sung;"],
	[2, "&flat;"],
	[0, "&natural;"],
	[0, "&sharp;"],
	[163, "&check;"],
	[3, "&cross;"],
	[8, "&malt;"],
	[21, "&sext;"],
	[33, "&VerticalSeparator;"],
	[25, "&lbbrk;"],
	[0, "&rbbrk;"],
	[84, "&bsolhsub;"],
	[0, "&suphsol;"],
	[28, "&LeftDoubleBracket;"],
	[0, "&RightDoubleBracket;"],
	[0, "&lang;"],
	[0, "&rang;"],
	[0, "&Lang;"],
	[0, "&Rang;"],
	[0, "&loang;"],
	[0, "&roang;"],
	[7, "&longleftarrow;"],
	[0, "&longrightarrow;"],
	[0, "&longleftrightarrow;"],
	[0, "&DoubleLongLeftArrow;"],
	[0, "&DoubleLongRightArrow;"],
	[0, "&DoubleLongLeftRightArrow;"],
	[1, "&longmapsto;"],
	[2, "&dzigrarr;"],
	[258, "&nvlArr;"],
	[0, "&nvrArr;"],
	[0, "&nvHarr;"],
	[0, "&Map;"],
	[6, "&lbarr;"],
	[0, "&bkarow;"],
	[0, "&lBarr;"],
	[0, "&dbkarow;"],
	[0, "&drbkarow;"],
	[0, "&DDotrahd;"],
	[0, "&UpArrowBar;"],
	[0, "&DownArrowBar;"],
	[2, "&Rarrtl;"],
	[2, "&latail;"],
	[0, "&ratail;"],
	[0, "&lAtail;"],
	[0, "&rAtail;"],
	[0, "&larrfs;"],
	[0, "&rarrfs;"],
	[0, "&larrbfs;"],
	[0, "&rarrbfs;"],
	[2, "&nwarhk;"],
	[0, "&nearhk;"],
	[0, "&hksearow;"],
	[0, "&hkswarow;"],
	[0, "&nwnear;"],
	[0, "&nesear;"],
	[0, "&seswar;"],
	[0, "&swnwar;"],
	[8, {
		v: "&rarrc;",
		n: 824,
		o: "&nrarrc;"
	}],
	[1, "&cudarrr;"],
	[0, "&ldca;"],
	[0, "&rdca;"],
	[0, "&cudarrl;"],
	[0, "&larrpl;"],
	[2, "&curarrm;"],
	[0, "&cularrp;"],
	[7, "&rarrpl;"],
	[2, "&harrcir;"],
	[0, "&Uarrocir;"],
	[0, "&lurdshar;"],
	[0, "&ldrushar;"],
	[2, "&LeftRightVector;"],
	[0, "&RightUpDownVector;"],
	[0, "&DownLeftRightVector;"],
	[0, "&LeftUpDownVector;"],
	[0, "&LeftVectorBar;"],
	[0, "&RightVectorBar;"],
	[0, "&RightUpVectorBar;"],
	[0, "&RightDownVectorBar;"],
	[0, "&DownLeftVectorBar;"],
	[0, "&DownRightVectorBar;"],
	[0, "&LeftUpVectorBar;"],
	[0, "&LeftDownVectorBar;"],
	[0, "&LeftTeeVector;"],
	[0, "&RightTeeVector;"],
	[0, "&RightUpTeeVector;"],
	[0, "&RightDownTeeVector;"],
	[0, "&DownLeftTeeVector;"],
	[0, "&DownRightTeeVector;"],
	[0, "&LeftUpTeeVector;"],
	[0, "&LeftDownTeeVector;"],
	[0, "&lHar;"],
	[0, "&uHar;"],
	[0, "&rHar;"],
	[0, "&dHar;"],
	[0, "&luruhar;"],
	[0, "&ldrdhar;"],
	[0, "&ruluhar;"],
	[0, "&rdldhar;"],
	[0, "&lharul;"],
	[0, "&llhard;"],
	[0, "&rharul;"],
	[0, "&lrhard;"],
	[0, "&udhar;"],
	[0, "&duhar;"],
	[0, "&RoundImplies;"],
	[0, "&erarr;"],
	[0, "&simrarr;"],
	[0, "&larrsim;"],
	[0, "&rarrsim;"],
	[0, "&rarrap;"],
	[0, "&ltlarr;"],
	[1, "&gtrarr;"],
	[0, "&subrarr;"],
	[1, "&suplarr;"],
	[0, "&lfisht;"],
	[0, "&rfisht;"],
	[0, "&ufisht;"],
	[0, "&dfisht;"],
	[5, "&lopar;"],
	[0, "&ropar;"],
	[4, "&lbrke;"],
	[0, "&rbrke;"],
	[0, "&lbrkslu;"],
	[0, "&rbrksld;"],
	[0, "&lbrksld;"],
	[0, "&rbrkslu;"],
	[0, "&langd;"],
	[0, "&rangd;"],
	[0, "&lparlt;"],
	[0, "&rpargt;"],
	[0, "&gtlPar;"],
	[0, "&ltrPar;"],
	[3, "&vzigzag;"],
	[1, "&vangrt;"],
	[0, "&angrtvbd;"],
	[6, "&ange;"],
	[0, "&range;"],
	[0, "&dwangle;"],
	[0, "&uwangle;"],
	[0, "&angmsdaa;"],
	[0, "&angmsdab;"],
	[0, "&angmsdac;"],
	[0, "&angmsdad;"],
	[0, "&angmsdae;"],
	[0, "&angmsdaf;"],
	[0, "&angmsdag;"],
	[0, "&angmsdah;"],
	[0, "&bemptyv;"],
	[0, "&demptyv;"],
	[0, "&cemptyv;"],
	[0, "&raemptyv;"],
	[0, "&laemptyv;"],
	[0, "&ohbar;"],
	[0, "&omid;"],
	[0, "&opar;"],
	[1, "&operp;"],
	[1, "&olcross;"],
	[0, "&odsold;"],
	[1, "&olcir;"],
	[0, "&ofcir;"],
	[0, "&olt;"],
	[0, "&ogt;"],
	[0, "&cirscir;"],
	[0, "&cirE;"],
	[0, "&solb;"],
	[0, "&bsolb;"],
	[3, "&boxbox;"],
	[3, "&trisb;"],
	[0, "&rtriltri;"],
	[0, {
		v: "&LeftTriangleBar;",
		n: 824,
		o: "&NotLeftTriangleBar;"
	}],
	[0, {
		v: "&RightTriangleBar;",
		n: 824,
		o: "&NotRightTriangleBar;"
	}],
	[11, "&iinfin;"],
	[0, "&infintie;"],
	[0, "&nvinfin;"],
	[4, "&eparsl;"],
	[0, "&smeparsl;"],
	[0, "&eqvparsl;"],
	[5, "&blacklozenge;"],
	[8, "&RuleDelayed;"],
	[1, "&dsol;"],
	[9, "&bigodot;"],
	[0, "&bigoplus;"],
	[0, "&bigotimes;"],
	[1, "&biguplus;"],
	[1, "&bigsqcup;"],
	[5, "&iiiint;"],
	[0, "&fpartint;"],
	[2, "&cirfnint;"],
	[0, "&awint;"],
	[0, "&rppolint;"],
	[0, "&scpolint;"],
	[0, "&npolint;"],
	[0, "&pointint;"],
	[0, "&quatint;"],
	[0, "&intlarhk;"],
	[10, "&pluscir;"],
	[0, "&plusacir;"],
	[0, "&simplus;"],
	[0, "&plusdu;"],
	[0, "&plussim;"],
	[0, "&plustwo;"],
	[1, "&mcomma;"],
	[0, "&minusdu;"],
	[2, "&loplus;"],
	[0, "&roplus;"],
	[0, "&Cross;"],
	[0, "&timesd;"],
	[0, "&timesbar;"],
	[1, "&smashp;"],
	[0, "&lotimes;"],
	[0, "&rotimes;"],
	[0, "&otimesas;"],
	[0, "&Otimes;"],
	[0, "&odiv;"],
	[0, "&triplus;"],
	[0, "&triminus;"],
	[0, "&tritime;"],
	[0, "&intprod;"],
	[2, "&amalg;"],
	[0, "&capdot;"],
	[1, "&ncup;"],
	[0, "&ncap;"],
	[0, "&capand;"],
	[0, "&cupor;"],
	[0, "&cupcap;"],
	[0, "&capcup;"],
	[0, "&cupbrcap;"],
	[0, "&capbrcup;"],
	[0, "&cupcup;"],
	[0, "&capcap;"],
	[0, "&ccups;"],
	[0, "&ccaps;"],
	[2, "&ccupssm;"],
	[2, "&And;"],
	[0, "&Or;"],
	[0, "&andand;"],
	[0, "&oror;"],
	[0, "&orslope;"],
	[0, "&andslope;"],
	[1, "&andv;"],
	[0, "&orv;"],
	[0, "&andd;"],
	[0, "&ord;"],
	[1, "&wedbar;"],
	[6, "&sdote;"],
	[3, "&simdot;"],
	[2, {
		v: "&congdot;",
		n: 824,
		o: "&ncongdot;"
	}],
	[0, "&easter;"],
	[0, "&apacir;"],
	[0, {
		v: "&apE;",
		n: 824,
		o: "&napE;"
	}],
	[0, "&eplus;"],
	[0, "&pluse;"],
	[0, "&Esim;"],
	[0, "&Colone;"],
	[0, "&Equal;"],
	[1, "&ddotseq;"],
	[0, "&equivDD;"],
	[0, "&ltcir;"],
	[0, "&gtcir;"],
	[0, "&ltquest;"],
	[0, "&gtquest;"],
	[0, {
		v: "&leqslant;",
		n: 824,
		o: "&nleqslant;"
	}],
	[0, {
		v: "&geqslant;",
		n: 824,
		o: "&ngeqslant;"
	}],
	[0, "&lesdot;"],
	[0, "&gesdot;"],
	[0, "&lesdoto;"],
	[0, "&gesdoto;"],
	[0, "&lesdotor;"],
	[0, "&gesdotol;"],
	[0, "&lap;"],
	[0, "&gap;"],
	[0, "&lne;"],
	[0, "&gne;"],
	[0, "&lnap;"],
	[0, "&gnap;"],
	[0, "&lEg;"],
	[0, "&gEl;"],
	[0, "&lsime;"],
	[0, "&gsime;"],
	[0, "&lsimg;"],
	[0, "&gsiml;"],
	[0, "&lgE;"],
	[0, "&glE;"],
	[0, "&lesges;"],
	[0, "&gesles;"],
	[0, "&els;"],
	[0, "&egs;"],
	[0, "&elsdot;"],
	[0, "&egsdot;"],
	[0, "&el;"],
	[0, "&eg;"],
	[2, "&siml;"],
	[0, "&simg;"],
	[0, "&simlE;"],
	[0, "&simgE;"],
	[0, {
		v: "&LessLess;",
		n: 824,
		o: "&NotNestedLessLess;"
	}],
	[0, {
		v: "&GreaterGreater;",
		n: 824,
		o: "&NotNestedGreaterGreater;"
	}],
	[1, "&glj;"],
	[0, "&gla;"],
	[0, "&ltcc;"],
	[0, "&gtcc;"],
	[0, "&lescc;"],
	[0, "&gescc;"],
	[0, "&smt;"],
	[0, "&lat;"],
	[0, {
		v: "&smte;",
		n: 65024,
		o: "&smtes;"
	}],
	[0, {
		v: "&late;",
		n: 65024,
		o: "&lates;"
	}],
	[0, "&bumpE;"],
	[0, {
		v: "&PrecedesEqual;",
		n: 824,
		o: "&NotPrecedesEqual;"
	}],
	[0, {
		v: "&sce;",
		n: 824,
		o: "&NotSucceedsEqual;"
	}],
	[2, "&prE;"],
	[0, "&scE;"],
	[0, "&precneqq;"],
	[0, "&scnE;"],
	[0, "&prap;"],
	[0, "&scap;"],
	[0, "&precnapprox;"],
	[0, "&scnap;"],
	[0, "&Pr;"],
	[0, "&Sc;"],
	[0, "&subdot;"],
	[0, "&supdot;"],
	[0, "&subplus;"],
	[0, "&supplus;"],
	[0, "&submult;"],
	[0, "&supmult;"],
	[0, "&subedot;"],
	[0, "&supedot;"],
	[0, {
		v: "&subE;",
		n: 824,
		o: "&nsubE;"
	}],
	[0, {
		v: "&supE;",
		n: 824,
		o: "&nsupE;"
	}],
	[0, "&subsim;"],
	[0, "&supsim;"],
	[2, {
		v: "&subnE;",
		n: 65024,
		o: "&varsubsetneqq;"
	}],
	[0, {
		v: "&supnE;",
		n: 65024,
		o: "&varsupsetneqq;"
	}],
	[2, "&csub;"],
	[0, "&csup;"],
	[0, "&csube;"],
	[0, "&csupe;"],
	[0, "&subsup;"],
	[0, "&supsub;"],
	[0, "&subsub;"],
	[0, "&supsup;"],
	[0, "&suphsub;"],
	[0, "&supdsub;"],
	[0, "&forkv;"],
	[0, "&topfork;"],
	[0, "&mlcp;"],
	[8, "&Dashv;"],
	[1, "&Vdashl;"],
	[0, "&Barv;"],
	[0, "&vBar;"],
	[0, "&vBarv;"],
	[1, "&Vbar;"],
	[0, "&Not;"],
	[0, "&bNot;"],
	[0, "&rnmid;"],
	[0, "&cirmid;"],
	[0, "&midcir;"],
	[0, "&topcir;"],
	[0, "&nhpar;"],
	[0, "&parsim;"],
	[9, {
		v: "&parsl;",
		n: 8421,
		o: "&nparsl;"
	}],
	[44343, { n: new Map(/* @__PURE__ */ restoreDiff([
		[56476, "&Ascr;"],
		[1, "&Cscr;"],
		[0, "&Dscr;"],
		[2, "&Gscr;"],
		[2, "&Jscr;"],
		[0, "&Kscr;"],
		[2, "&Nscr;"],
		[0, "&Oscr;"],
		[0, "&Pscr;"],
		[0, "&Qscr;"],
		[1, "&Sscr;"],
		[0, "&Tscr;"],
		[0, "&Uscr;"],
		[0, "&Vscr;"],
		[0, "&Wscr;"],
		[0, "&Xscr;"],
		[0, "&Yscr;"],
		[0, "&Zscr;"],
		[0, "&ascr;"],
		[0, "&bscr;"],
		[0, "&cscr;"],
		[0, "&dscr;"],
		[1, "&fscr;"],
		[1, "&hscr;"],
		[0, "&iscr;"],
		[0, "&jscr;"],
		[0, "&kscr;"],
		[0, "&lscr;"],
		[0, "&mscr;"],
		[0, "&nscr;"],
		[1, "&pscr;"],
		[0, "&qscr;"],
		[0, "&rscr;"],
		[0, "&sscr;"],
		[0, "&tscr;"],
		[0, "&uscr;"],
		[0, "&vscr;"],
		[0, "&wscr;"],
		[0, "&xscr;"],
		[0, "&yscr;"],
		[0, "&zscr;"],
		[52, "&Afr;"],
		[0, "&Bfr;"],
		[1, "&Dfr;"],
		[0, "&Efr;"],
		[0, "&Ffr;"],
		[0, "&Gfr;"],
		[2, "&Jfr;"],
		[0, "&Kfr;"],
		[0, "&Lfr;"],
		[0, "&Mfr;"],
		[0, "&Nfr;"],
		[0, "&Ofr;"],
		[0, "&Pfr;"],
		[0, "&Qfr;"],
		[1, "&Sfr;"],
		[0, "&Tfr;"],
		[0, "&Ufr;"],
		[0, "&Vfr;"],
		[0, "&Wfr;"],
		[0, "&Xfr;"],
		[0, "&Yfr;"],
		[1, "&afr;"],
		[0, "&bfr;"],
		[0, "&cfr;"],
		[0, "&dfr;"],
		[0, "&efr;"],
		[0, "&ffr;"],
		[0, "&gfr;"],
		[0, "&hfr;"],
		[0, "&ifr;"],
		[0, "&jfr;"],
		[0, "&kfr;"],
		[0, "&lfr;"],
		[0, "&mfr;"],
		[0, "&nfr;"],
		[0, "&ofr;"],
		[0, "&pfr;"],
		[0, "&qfr;"],
		[0, "&rfr;"],
		[0, "&sfr;"],
		[0, "&tfr;"],
		[0, "&ufr;"],
		[0, "&vfr;"],
		[0, "&wfr;"],
		[0, "&xfr;"],
		[0, "&yfr;"],
		[0, "&zfr;"],
		[0, "&Aopf;"],
		[0, "&Bopf;"],
		[1, "&Dopf;"],
		[0, "&Eopf;"],
		[0, "&Fopf;"],
		[0, "&Gopf;"],
		[1, "&Iopf;"],
		[0, "&Jopf;"],
		[0, "&Kopf;"],
		[0, "&Lopf;"],
		[0, "&Mopf;"],
		[1, "&Oopf;"],
		[3, "&Sopf;"],
		[0, "&Topf;"],
		[0, "&Uopf;"],
		[0, "&Vopf;"],
		[0, "&Wopf;"],
		[0, "&Xopf;"],
		[0, "&Yopf;"],
		[1, "&aopf;"],
		[0, "&bopf;"],
		[0, "&copf;"],
		[0, "&dopf;"],
		[0, "&eopf;"],
		[0, "&fopf;"],
		[0, "&gopf;"],
		[0, "&hopf;"],
		[0, "&iopf;"],
		[0, "&jopf;"],
		[0, "&kopf;"],
		[0, "&lopf;"],
		[0, "&mopf;"],
		[0, "&nopf;"],
		[0, "&oopf;"],
		[0, "&popf;"],
		[0, "&qopf;"],
		[0, "&ropf;"],
		[0, "&sopf;"],
		[0, "&topf;"],
		[0, "&uopf;"],
		[0, "&vopf;"],
		[0, "&wopf;"],
		[0, "&xopf;"],
		[0, "&yopf;"],
		[0, "&zopf;"]
	])) }],
	[8906, "&fflig;"],
	[0, "&filig;"],
	[0, "&fllig;"],
	[0, "&ffilig;"],
	[0, "&ffllig;"]
]));
const xmlCodeMap = new Map([
	[34, "&quot;"],
	[38, "&amp;"],
	[39, "&apos;"],
	[60, "&lt;"],
	[62, "&gt;"]
]);
String.prototype.codePointAt;
/**
* Creates a function that escapes all characters matched by the given regular
* expression using the given map of characters to escape to their entities.
*
* @param regex Regular expression to match characters to escape.
* @param map Map of characters to escape to their entities.
*
* @returns Function that escapes all characters matched by the given regular
* expression using the given map of characters to escape to their entities.
*/
function getEscaper(regex, map) {
	return function escape(data) {
		let match;
		let lastIdx = 0;
		let result = "";
		while (match = regex.exec(data)) {
			if (lastIdx !== match.index) result += data.substring(lastIdx, match.index);
			result += map.get(match[0].charCodeAt(0));
			lastIdx = match.index + 1;
		}
		return result + data.substring(lastIdx);
	};
}
getEscaper(/[&<>'"]/g, xmlCodeMap);
getEscaper(/["&\u00A0]/g, new Map([
	[34, "&quot;"],
	[38, "&amp;"],
	[160, "&nbsp;"]
]));
getEscaper(/[&<>\u00A0]/g, new Map([
	[38, "&amp;"],
	[60, "&lt;"],
	[62, "&gt;"],
	[160, "&nbsp;"]
]));
/** The level of entities to support. */
var EntityLevel;
(function(EntityLevel) {
	/** Support only XML entities. */
	EntityLevel[EntityLevel["XML"] = 0] = "XML";
	/** Support HTML entities, which are a superset of XML entities. */
	EntityLevel[EntityLevel["HTML"] = 1] = "HTML";
})(EntityLevel || (EntityLevel = {}));
var EncodingMode;
(function(EncodingMode) {
	/**
	* The output is UTF-8 encoded. Only characters that need escaping within
	* XML will be escaped.
	*/
	EncodingMode[EncodingMode["UTF8"] = 0] = "UTF8";
	/**
	* The output consists only of ASCII characters. Characters that need
	* escaping within HTML, and characters that aren't ASCII characters will
	* be escaped.
	*/
	EncodingMode[EncodingMode["ASCII"] = 1] = "ASCII";
	/**
	* Encode all characters that have an equivalent entity, as well as all
	* characters that are not ASCII characters.
	*/
	EncodingMode[EncodingMode["Extensive"] = 2] = "Extensive";
	/**
	* Encode all characters that have to be escaped in HTML attributes,
	* following {@link https://html.spec.whatwg.org/multipage/parsing.html#escapingString}.
	*/
	EncodingMode[EncodingMode["Attribute"] = 3] = "Attribute";
	/**
	* Encode all characters that have to be escaped in HTML text,
	* following {@link https://html.spec.whatwg.org/multipage/parsing.html#escapingString}.
	*/
	EncodingMode[EncodingMode["Text"] = 4] = "Text";
})(EncodingMode || (EncodingMode = {}));
var utils_exports = /* @__PURE__ */ __exportAll({
	arrayReplaceAt: () => arrayReplaceAt,
	assign: () => assign$1,
	escapeHtml: () => escapeHtml,
	escapeRE: () => escapeRE$1,
	fromCodePoint: () => fromCodePoint,
	has: () => has,
	isMdAsciiPunct: () => isMdAsciiPunct,
	isPunctChar: () => isPunctChar,
	isSpace: () => isSpace,
	isString: () => isString$1,
	isValidEntityCode: () => isValidEntityCode,
	isWhiteSpace: () => isWhiteSpace,
	lib: () => lib,
	normalizeReference: () => normalizeReference,
	unescapeAll: () => unescapeAll,
	unescapeMd: () => unescapeMd
});
function _class$1(obj) {
	return Object.prototype.toString.call(obj);
}
function isString$1(obj) {
	return _class$1(obj) === "[object String]";
}
const _hasOwnProperty = Object.prototype.hasOwnProperty;
function has(object, key) {
	return _hasOwnProperty.call(object, key);
}
function assign$1(obj) {
	Array.prototype.slice.call(arguments, 1).forEach(function(source) {
		if (!source) return;
		if (typeof source !== "object") throw new TypeError(source + "must be object");
		Object.keys(source).forEach(function(key) {
			obj[key] = source[key];
		});
	});
	return obj;
}
function arrayReplaceAt(src, pos, newElements) {
	return [].concat(src.slice(0, pos), newElements, src.slice(pos + 1));
}
function isValidEntityCode(c) {
	if (c >= 55296 && c <= 57343) return false;
	if (c >= 64976 && c <= 65007) return false;
	if ((c & 65535) === 65535 || (c & 65535) === 65534) return false;
	if (c >= 0 && c <= 8) return false;
	if (c === 11) return false;
	if (c >= 14 && c <= 31) return false;
	if (c >= 127 && c <= 159) return false;
	if (c > 1114111) return false;
	return true;
}
function fromCodePoint(c) {
	if (c > 65535) {
		c -= 65536;
		const surrogate1 = 55296 + (c >> 10);
		const surrogate2 = 56320 + (c & 1023);
		return String.fromCharCode(surrogate1, surrogate2);
	}
	return String.fromCharCode(c);
}
const UNESCAPE_MD_RE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g;
const UNESCAPE_ALL_RE = new RegExp(UNESCAPE_MD_RE.source + "|" + /&([a-z#][a-z0-9]{1,31});/gi.source, "gi");
const DIGITAL_ENTITY_TEST_RE = /^#((?:x[a-f0-9]{1,8}|[0-9]{1,8}))$/i;
function replaceEntityPattern(match, name) {
	if (name.charCodeAt(0) === 35 && DIGITAL_ENTITY_TEST_RE.test(name)) {
		const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
		if (isValidEntityCode(code)) return fromCodePoint(code);
		return match;
	}
	const decoded = decodeHTML(match);
	if (decoded !== match) return decoded;
	return match;
}
function unescapeMd(str) {
	if (str.indexOf("\\") < 0) return str;
	return str.replace(UNESCAPE_MD_RE, "$1");
}
function unescapeAll(str) {
	if (str.indexOf("\\") < 0 && str.indexOf("&") < 0) return str;
	return str.replace(UNESCAPE_ALL_RE, function(match, escaped, entity) {
		if (escaped) return escaped;
		return replaceEntityPattern(match, entity);
	});
}
const HTML_ESCAPE_TEST_RE = /[&<>"]/;
const HTML_ESCAPE_REPLACE_RE = /[&<>"]/g;
const HTML_REPLACEMENTS = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	"\"": "&quot;"
};
function replaceUnsafeChar(ch) {
	return HTML_REPLACEMENTS[ch];
}
function escapeHtml(str) {
	if (HTML_ESCAPE_TEST_RE.test(str)) return str.replace(HTML_ESCAPE_REPLACE_RE, replaceUnsafeChar);
	return str;
}
const REGEXP_ESCAPE_RE = /[.?*+^$[\]\\(){}|-]/g;
function escapeRE$1(str) {
	return str.replace(REGEXP_ESCAPE_RE, "\\$&");
}
function isSpace(code) {
	switch (code) {
		case 9:
		case 32: return true;
	}
	return false;
}
function isWhiteSpace(code) {
	if (code >= 8192 && code <= 8202) return true;
	switch (code) {
		case 9:
		case 10:
		case 11:
		case 12:
		case 13:
		case 32:
		case 160:
		case 5760:
		case 8239:
		case 8287:
		case 12288: return true;
	}
	return false;
}
function isPunctChar(ch) {
	return regex_default$2.test(ch) || regex_default$1.test(ch);
}
function isMdAsciiPunct(ch) {
	switch (ch) {
		case 33:
		case 34:
		case 35:
		case 36:
		case 37:
		case 38:
		case 39:
		case 40:
		case 41:
		case 42:
		case 43:
		case 44:
		case 45:
		case 46:
		case 47:
		case 58:
		case 59:
		case 60:
		case 61:
		case 62:
		case 63:
		case 64:
		case 91:
		case 92:
		case 93:
		case 94:
		case 95:
		case 96:
		case 123:
		case 124:
		case 125:
		case 126: return true;
		default: return false;
	}
}
function normalizeReference(str) {
	str = str.trim().replace(/\s+/g, " ");
	if ("ẞ".toLowerCase() === "Ṿ") str = str.replace(/ẞ/g, "ß");
	return str.toLowerCase().toUpperCase();
}
const lib = {
	mdurl: mdurl_exports,
	ucmicro: uc_micro_exports
};
function parseLinkLabel(state, start, disableNested) {
	let level, found, marker, prevPos;
	const max = state.posMax;
	const oldPos = state.pos;
	state.pos = start + 1;
	level = 1;
	while (state.pos < max) {
		marker = state.src.charCodeAt(state.pos);
		if (marker === 93) {
			level--;
			if (level === 0) {
				found = true;
				break;
			}
		}
		prevPos = state.pos;
		state.md.inline.skipToken(state);
		if (marker === 91) {
			if (prevPos === state.pos - 1) level++;
			else if (disableNested) {
				state.pos = oldPos;
				return -1;
			}
		}
	}
	let labelEnd = -1;
	if (found) labelEnd = state.pos;
	state.pos = oldPos;
	return labelEnd;
}
function parseLinkDestination(str, start, max) {
	let code;
	let pos = start;
	const result = {
		ok: false,
		pos: 0,
		str: ""
	};
	if (str.charCodeAt(pos) === 60) {
		pos++;
		while (pos < max) {
			code = str.charCodeAt(pos);
			if (code === 10) return result;
			if (code === 60) return result;
			if (code === 62) {
				result.pos = pos + 1;
				result.str = unescapeAll(str.slice(start + 1, pos));
				result.ok = true;
				return result;
			}
			if (code === 92 && pos + 1 < max) {
				pos += 2;
				continue;
			}
			pos++;
		}
		return result;
	}
	let level = 0;
	while (pos < max) {
		code = str.charCodeAt(pos);
		if (code === 32) break;
		if (code < 32 || code === 127) break;
		if (code === 92 && pos + 1 < max) {
			if (str.charCodeAt(pos + 1) === 32) break;
			pos += 2;
			continue;
		}
		if (code === 40) {
			level++;
			if (level > 32) return result;
		}
		if (code === 41) {
			if (level === 0) break;
			level--;
		}
		pos++;
	}
	if (start === pos) return result;
	if (level !== 0) return result;
	result.str = unescapeAll(str.slice(start, pos));
	result.pos = pos;
	result.ok = true;
	return result;
}
function parseLinkTitle(str, start, max, prev_state) {
	let code;
	let pos = start;
	const state = {
		ok: false,
		can_continue: false,
		pos: 0,
		str: "",
		marker: 0
	};
	if (prev_state) {
		state.str = prev_state.str;
		state.marker = prev_state.marker;
	} else {
		if (pos >= max) return state;
		let marker = str.charCodeAt(pos);
		if (marker !== 34 && marker !== 39 && marker !== 40) return state;
		start++;
		pos++;
		if (marker === 40) marker = 41;
		state.marker = marker;
	}
	while (pos < max) {
		code = str.charCodeAt(pos);
		if (code === state.marker) {
			state.pos = pos + 1;
			state.str += unescapeAll(str.slice(start, pos));
			state.ok = true;
			return state;
		} else if (code === 40 && state.marker === 41) return state;
		else if (code === 92 && pos + 1 < max) pos++;
		pos++;
	}
	state.can_continue = true;
	state.str += unescapeAll(str.slice(start, pos));
	return state;
}
var helpers_exports = /* @__PURE__ */ __exportAll({
	parseLinkDestination: () => parseLinkDestination,
	parseLinkLabel: () => parseLinkLabel,
	parseLinkTitle: () => parseLinkTitle
});
/**
* class Renderer
*
* Generates HTML from parsed token stream. Each instance has independent
* copy of rules. Those can be rewritten with ease. Also, you can add new
* rules if you create plugin and adds new token types.
**/
const default_rules = {};
default_rules.code_inline = function(tokens, idx, options, env, slf) {
	const token = tokens[idx];
	return "<code" + slf.renderAttrs(token) + ">" + escapeHtml(token.content) + "</code>";
};
default_rules.code_block = function(tokens, idx, options, env, slf) {
	const token = tokens[idx];
	return "<pre" + slf.renderAttrs(token) + "><code>" + escapeHtml(tokens[idx].content) + "</code></pre>\n";
};
default_rules.fence = function(tokens, idx, options, env, slf) {
	const token = tokens[idx];
	const info = token.info ? unescapeAll(token.info).trim() : "";
	let langName = "";
	let langAttrs = "";
	if (info) {
		const arr = info.split(/(\s+)/g);
		langName = arr[0];
		langAttrs = arr.slice(2).join("");
	}
	let highlighted;
	if (options.highlight) highlighted = options.highlight(token.content, langName, langAttrs) || escapeHtml(token.content);
	else highlighted = escapeHtml(token.content);
	if (highlighted.indexOf("<pre") === 0) return highlighted + "\n";
	if (info) {
		const i = token.attrIndex("class");
		const tmpAttrs = token.attrs ? token.attrs.slice() : [];
		if (i < 0) tmpAttrs.push(["class", options.langPrefix + langName]);
		else {
			tmpAttrs[i] = tmpAttrs[i].slice();
			tmpAttrs[i][1] += " " + options.langPrefix + langName;
		}
		const tmpToken = { attrs: tmpAttrs };
		return `<pre><code${slf.renderAttrs(tmpToken)}>${highlighted}</code></pre>\n`;
	}
	return `<pre><code${slf.renderAttrs(token)}>${highlighted}</code></pre>\n`;
};
default_rules.image = function(tokens, idx, options, env, slf) {
	const token = tokens[idx];
	token.attrs[token.attrIndex("alt")][1] = slf.renderInlineAsText(token.children, options, env);
	return slf.renderToken(tokens, idx, options);
};
default_rules.hardbreak = function(tokens, idx, options) {
	return options.xhtmlOut ? "<br />\n" : "<br>\n";
};
default_rules.softbreak = function(tokens, idx, options) {
	return options.breaks ? options.xhtmlOut ? "<br />\n" : "<br>\n" : "\n";
};
default_rules.text = function(tokens, idx) {
	return escapeHtml(tokens[idx].content);
};
default_rules.html_block = function(tokens, idx) {
	return tokens[idx].content;
};
default_rules.html_inline = function(tokens, idx) {
	return tokens[idx].content;
};
/**
* new Renderer()
*
* Creates new [[Renderer]] instance and fill [[Renderer#rules]] with defaults.
**/
function Renderer() {
	/**
	* Renderer#rules -> Object
	*
	* Contains render rules for tokens. Can be updated and extended.
	*
	* ##### Example
	*
	* ```javascript
	* var md = require('markdown-it')();
	*
	* md.renderer.rules.strong_open  = function () { return '<b>'; };
	* md.renderer.rules.strong_close = function () { return '</b>'; };
	*
	* var result = md.renderInline(...);
	* ```
	*
	* Each rule is called as independent static function with fixed signature:
	*
	* ```javascript
	* function my_token_render(tokens, idx, options, env, renderer) {
	*   // ...
	*   return renderedHTML;
	* }
	* ```
	*
	* See [source code](https://github.com/markdown-it/markdown-it/blob/master/lib/renderer.mjs)
	* for more details and examples.
	**/
	this.rules = assign$1({}, default_rules);
}
/**
* Renderer.renderAttrs(token) -> String
*
* Render token attributes to string.
**/
Renderer.prototype.renderAttrs = function renderAttrs(token) {
	let i, l, result;
	if (!token.attrs) return "";
	result = "";
	for (i = 0, l = token.attrs.length; i < l; i++) result += " " + escapeHtml(token.attrs[i][0]) + "=\"" + escapeHtml(token.attrs[i][1]) + "\"";
	return result;
};
/**
* Renderer.renderToken(tokens, idx, options) -> String
* - tokens (Array): list of tokens
* - idx (Numbed): token index to render
* - options (Object): params of parser instance
*
* Default token renderer. Can be overriden by custom function
* in [[Renderer#rules]].
**/
Renderer.prototype.renderToken = function renderToken(tokens, idx, options) {
	const token = tokens[idx];
	let result = "";
	if (token.hidden) return "";
	if (token.block && token.nesting !== -1 && idx && tokens[idx - 1].hidden) result += "\n";
	result += (token.nesting === -1 ? "</" : "<") + token.tag;
	result += this.renderAttrs(token);
	if (token.nesting === 0 && options.xhtmlOut) result += " /";
	let needLf = false;
	if (token.block) {
		needLf = true;
		if (token.nesting === 1) {
			if (idx + 1 < tokens.length) {
				const nextToken = tokens[idx + 1];
				if (nextToken.type === "inline" || nextToken.hidden) needLf = false;
				else if (nextToken.nesting === -1 && nextToken.tag === token.tag) needLf = false;
			}
		}
	}
	result += needLf ? ">\n" : ">";
	return result;
};
/**
* Renderer.renderInline(tokens, options, env) -> String
* - tokens (Array): list on block tokens to render
* - options (Object): params of parser instance
* - env (Object): additional data from parsed input (references, for example)
*
* The same as [[Renderer.render]], but for single token of `inline` type.
**/
Renderer.prototype.renderInline = function(tokens, options, env) {
	let result = "";
	const rules = this.rules;
	for (let i = 0, len = tokens.length; i < len; i++) {
		const type = tokens[i].type;
		if (typeof rules[type] !== "undefined") result += rules[type](tokens, i, options, env, this);
		else result += this.renderToken(tokens, i, options);
	}
	return result;
};
/** internal
* Renderer.renderInlineAsText(tokens, options, env) -> String
* - tokens (Array): list on block tokens to render
* - options (Object): params of parser instance
* - env (Object): additional data from parsed input (references, for example)
*
* Special kludge for image `alt` attributes to conform CommonMark spec.
* Don't try to use it! Spec requires to show `alt` content with stripped markup,
* instead of simple escaping.
**/
Renderer.prototype.renderInlineAsText = function(tokens, options, env) {
	let result = "";
	for (let i = 0, len = tokens.length; i < len; i++) switch (tokens[i].type) {
		case "text":
			result += tokens[i].content;
			break;
		case "image":
			result += this.renderInlineAsText(tokens[i].children, options, env);
			break;
		case "html_inline":
		case "html_block":
			result += tokens[i].content;
			break;
		case "softbreak":
		case "hardbreak":
			result += "\n";
			break;
		default:
	}
	return result;
};
/**
* Renderer.render(tokens, options, env) -> String
* - tokens (Array): list on block tokens to render
* - options (Object): params of parser instance
* - env (Object): additional data from parsed input (references, for example)
*
* Takes token stream and generates HTML. Probably, you will never need to call
* this method directly.
**/
Renderer.prototype.render = function(tokens, options, env) {
	let result = "";
	const rules = this.rules;
	for (let i = 0, len = tokens.length; i < len; i++) {
		const type = tokens[i].type;
		if (type === "inline") result += this.renderInline(tokens[i].children, options, env);
		else if (typeof rules[type] !== "undefined") result += rules[type](tokens, i, options, env, this);
		else result += this.renderToken(tokens, i, options, env);
	}
	return result;
};
/**
* class Ruler
*
* Helper class, used by [[MarkdownIt#core]], [[MarkdownIt#block]] and
* [[MarkdownIt#inline]] to manage sequences of functions (rules):
*
* - keep rules in defined order
* - assign the name to each rule
* - enable/disable rules
* - add/replace rules
* - allow assign rules to additional named chains (in the same)
* - cacheing lists of active rules
*
* You will not need use this class directly until write plugins. For simple
* rules control use [[MarkdownIt.disable]], [[MarkdownIt.enable]] and
* [[MarkdownIt.use]].
**/
/**
* new Ruler()
**/
function Ruler() {
	this.__rules__ = [];
	this.__cache__ = null;
}
Ruler.prototype.__find__ = function(name) {
	for (let i = 0; i < this.__rules__.length; i++) if (this.__rules__[i].name === name) return i;
	return -1;
};
Ruler.prototype.__compile__ = function() {
	const self = this;
	const chains = [""];
	self.__rules__.forEach(function(rule) {
		if (!rule.enabled) return;
		rule.alt.forEach(function(altName) {
			if (chains.indexOf(altName) < 0) chains.push(altName);
		});
	});
	self.__cache__ = {};
	chains.forEach(function(chain) {
		self.__cache__[chain] = [];
		self.__rules__.forEach(function(rule) {
			if (!rule.enabled) return;
			if (chain && rule.alt.indexOf(chain) < 0) return;
			self.__cache__[chain].push(rule.fn);
		});
	});
};
/**
* Ruler.at(name, fn [, options])
* - name (String): rule name to replace.
* - fn (Function): new rule function.
* - options (Object): new rule options (not mandatory).
*
* Replace rule by name with new function & options. Throws error if name not
* found.
*
* ##### Options:
*
* - __alt__ - array with names of "alternate" chains.
*
* ##### Example
*
* Replace existing typographer replacement rule with new one:
*
* ```javascript
* var md = require('markdown-it')();
*
* md.core.ruler.at('replacements', function replace(state) {
*   //...
* });
* ```
**/
Ruler.prototype.at = function(name, fn, options) {
	const index = this.__find__(name);
	const opt = options || {};
	if (index === -1) throw new Error("Parser rule not found: " + name);
	this.__rules__[index].fn = fn;
	this.__rules__[index].alt = opt.alt || [];
	this.__cache__ = null;
};
/**
* Ruler.before(beforeName, ruleName, fn [, options])
* - beforeName (String): new rule will be added before this one.
* - ruleName (String): name of added rule.
* - fn (Function): rule function.
* - options (Object): rule options (not mandatory).
*
* Add new rule to chain before one with given name. See also
* [[Ruler.after]], [[Ruler.push]].
*
* ##### Options:
*
* - __alt__ - array with names of "alternate" chains.
*
* ##### Example
*
* ```javascript
* var md = require('markdown-it')();
*
* md.block.ruler.before('paragraph', 'my_rule', function replace(state) {
*   //...
* });
* ```
**/
Ruler.prototype.before = function(beforeName, ruleName, fn, options) {
	const index = this.__find__(beforeName);
	const opt = options || {};
	if (index === -1) throw new Error("Parser rule not found: " + beforeName);
	this.__rules__.splice(index, 0, {
		name: ruleName,
		enabled: true,
		fn,
		alt: opt.alt || []
	});
	this.__cache__ = null;
};
/**
* Ruler.after(afterName, ruleName, fn [, options])
* - afterName (String): new rule will be added after this one.
* - ruleName (String): name of added rule.
* - fn (Function): rule function.
* - options (Object): rule options (not mandatory).
*
* Add new rule to chain after one with given name. See also
* [[Ruler.before]], [[Ruler.push]].
*
* ##### Options:
*
* - __alt__ - array with names of "alternate" chains.
*
* ##### Example
*
* ```javascript
* var md = require('markdown-it')();
*
* md.inline.ruler.after('text', 'my_rule', function replace(state) {
*   //...
* });
* ```
**/
Ruler.prototype.after = function(afterName, ruleName, fn, options) {
	const index = this.__find__(afterName);
	const opt = options || {};
	if (index === -1) throw new Error("Parser rule not found: " + afterName);
	this.__rules__.splice(index + 1, 0, {
		name: ruleName,
		enabled: true,
		fn,
		alt: opt.alt || []
	});
	this.__cache__ = null;
};
/**
* Ruler.push(ruleName, fn [, options])
* - ruleName (String): name of added rule.
* - fn (Function): rule function.
* - options (Object): rule options (not mandatory).
*
* Push new rule to the end of chain. See also
* [[Ruler.before]], [[Ruler.after]].
*
* ##### Options:
*
* - __alt__ - array with names of "alternate" chains.
*
* ##### Example
*
* ```javascript
* var md = require('markdown-it')();
*
* md.core.ruler.push('my_rule', function replace(state) {
*   //...
* });
* ```
**/
Ruler.prototype.push = function(ruleName, fn, options) {
	const opt = options || {};
	this.__rules__.push({
		name: ruleName,
		enabled: true,
		fn,
		alt: opt.alt || []
	});
	this.__cache__ = null;
};
/**
* Ruler.enable(list [, ignoreInvalid]) -> Array
* - list (String|Array): list of rule names to enable.
* - ignoreInvalid (Boolean): set `true` to ignore errors when rule not found.
*
* Enable rules with given names. If any rule name not found - throw Error.
* Errors can be disabled by second param.
*
* Returns list of found rule names (if no exception happened).
*
* See also [[Ruler.disable]], [[Ruler.enableOnly]].
**/
Ruler.prototype.enable = function(list, ignoreInvalid) {
	if (!Array.isArray(list)) list = [list];
	const result = [];
	list.forEach(function(name) {
		const idx = this.__find__(name);
		if (idx < 0) {
			if (ignoreInvalid) return;
			throw new Error("Rules manager: invalid rule name " + name);
		}
		this.__rules__[idx].enabled = true;
		result.push(name);
	}, this);
	this.__cache__ = null;
	return result;
};
/**
* Ruler.enableOnly(list [, ignoreInvalid])
* - list (String|Array): list of rule names to enable (whitelist).
* - ignoreInvalid (Boolean): set `true` to ignore errors when rule not found.
*
* Enable rules with given names, and disable everything else. If any rule name
* not found - throw Error. Errors can be disabled by second param.
*
* See also [[Ruler.disable]], [[Ruler.enable]].
**/
Ruler.prototype.enableOnly = function(list, ignoreInvalid) {
	if (!Array.isArray(list)) list = [list];
	this.__rules__.forEach(function(rule) {
		rule.enabled = false;
	});
	this.enable(list, ignoreInvalid);
};
/**
* Ruler.disable(list [, ignoreInvalid]) -> Array
* - list (String|Array): list of rule names to disable.
* - ignoreInvalid (Boolean): set `true` to ignore errors when rule not found.
*
* Disable rules with given names. If any rule name not found - throw Error.
* Errors can be disabled by second param.
*
* Returns list of found rule names (if no exception happened).
*
* See also [[Ruler.enable]], [[Ruler.enableOnly]].
**/
Ruler.prototype.disable = function(list, ignoreInvalid) {
	if (!Array.isArray(list)) list = [list];
	const result = [];
	list.forEach(function(name) {
		const idx = this.__find__(name);
		if (idx < 0) {
			if (ignoreInvalid) return;
			throw new Error("Rules manager: invalid rule name " + name);
		}
		this.__rules__[idx].enabled = false;
		result.push(name);
	}, this);
	this.__cache__ = null;
	return result;
};
/**
* Ruler.getRules(chainName) -> Array
*
* Return array of active functions (rules) for given chain name. It analyzes
* rules configuration, compiles caches if not exists and returns result.
*
* Default chain name is `''` (empty string). It can't be skipped. That's
* done intentionally, to keep signature monomorphic for high speed.
**/
Ruler.prototype.getRules = function(chainName) {
	if (this.__cache__ === null) this.__compile__();
	return this.__cache__[chainName] || [];
};
/**
* class Token
**/
/**
* new Token(type, tag, nesting)
*
* Create new token and fill passed properties.
**/
function Token(type, tag, nesting) {
	/**
	* Token#type -> String
	*
	* Type of the token (string, e.g. "paragraph_open")
	**/
	this.type = type;
	/**
	* Token#tag -> String
	*
	* html tag name, e.g. "p"
	**/
	this.tag = tag;
	/**
	* Token#attrs -> Array
	*
	* Html attributes. Format: `[ [ name1, value1 ], [ name2, value2 ] ]`
	**/
	this.attrs = null;
	/**
	* Token#map -> Array
	*
	* Source map info. Format: `[ line_begin, line_end ]`
	**/
	this.map = null;
	/**
	* Token#nesting -> Number
	*
	* Level change (number in {-1, 0, 1} set), where:
	*
	* -  `1` means the tag is opening
	* -  `0` means the tag is self-closing
	* - `-1` means the tag is closing
	**/
	this.nesting = nesting;
	/**
	* Token#level -> Number
	*
	* nesting level, the same as `state.level`
	**/
	this.level = 0;
	/**
	* Token#children -> Array
	*
	* An array of child nodes (inline and img tokens)
	**/
	this.children = null;
	/**
	* Token#content -> String
	*
	* In a case of self-closing tag (code, html, fence, etc.),
	* it has contents of this tag.
	**/
	this.content = "";
	/**
	* Token#markup -> String
	*
	* '*' or '_' for emphasis, fence string for fence, etc.
	**/
	this.markup = "";
	/**
	* Token#info -> String
	*
	* Additional information:
	*
	* - Info string for "fence" tokens
	* - The value "auto" for autolink "link_open" and "link_close" tokens
	* - The string value of the item marker for ordered-list "list_item_open" tokens
	**/
	this.info = "";
	/**
	* Token#meta -> Object
	*
	* A place for plugins to store an arbitrary data
	**/
	this.meta = null;
	/**
	* Token#block -> Boolean
	*
	* True for block-level tokens, false for inline tokens.
	* Used in renderer to calculate line breaks
	**/
	this.block = false;
	/**
	* Token#hidden -> Boolean
	*
	* If it's true, ignore this element when rendering. Used for tight lists
	* to hide paragraphs.
	**/
	this.hidden = false;
}
/**
* Token.attrIndex(name) -> Number
*
* Search attribute index by name.
**/
Token.prototype.attrIndex = function attrIndex(name) {
	if (!this.attrs) return -1;
	const attrs = this.attrs;
	for (let i = 0, len = attrs.length; i < len; i++) if (attrs[i][0] === name) return i;
	return -1;
};
/**
* Token.attrPush(attrData)
*
* Add `[ name, value ]` attribute to list. Init attrs if necessary
**/
Token.prototype.attrPush = function attrPush(attrData) {
	if (this.attrs) this.attrs.push(attrData);
	else this.attrs = [attrData];
};
/**
* Token.attrSet(name, value)
*
* Set `name` attribute to `value`. Override old value if exists.
**/
Token.prototype.attrSet = function attrSet(name, value) {
	const idx = this.attrIndex(name);
	const attrData = [name, value];
	if (idx < 0) this.attrPush(attrData);
	else this.attrs[idx] = attrData;
};
/**
* Token.attrGet(name)
*
* Get the value of attribute `name`, or null if it does not exist.
**/
Token.prototype.attrGet = function attrGet(name) {
	const idx = this.attrIndex(name);
	let value = null;
	if (idx >= 0) value = this.attrs[idx][1];
	return value;
};
/**
* Token.attrJoin(name, value)
*
* Join value to existing attribute via space. Or create new attribute if not
* exists. Useful to operate with token classes.
**/
Token.prototype.attrJoin = function attrJoin(name, value) {
	const idx = this.attrIndex(name);
	if (idx < 0) this.attrPush([name, value]);
	else this.attrs[idx][1] = this.attrs[idx][1] + " " + value;
};
function StateCore(src, md, env) {
	this.src = src;
	this.env = env;
	this.tokens = [];
	this.inlineMode = false;
	this.md = md;
}
StateCore.prototype.Token = Token;
const NEWLINES_RE = /\r\n?|\n/g;
const NULL_RE = /\0/g;
function normalize(state) {
	let str;
	str = state.src.replace(NEWLINES_RE, "\n");
	str = str.replace(NULL_RE, "�");
	state.src = str;
}
function block(state) {
	let token;
	if (state.inlineMode) {
		token = new state.Token("inline", "", 0);
		token.content = state.src;
		token.map = [0, 1];
		token.children = [];
		state.tokens.push(token);
	} else state.md.block.parse(state.src, state.md, state.env, state.tokens);
}
function inline(state) {
	const tokens = state.tokens;
	for (let i = 0, l = tokens.length; i < l; i++) {
		const tok = tokens[i];
		if (tok.type === "inline") state.md.inline.parse(tok.content, state.md, state.env, tok.children);
	}
}
function isLinkOpen$1(str) {
	return /^<a[>\s]/i.test(str);
}
function isLinkClose$1(str) {
	return /^<\/a\s*>/i.test(str);
}
function linkify$1(state) {
	const blockTokens = state.tokens;
	if (!state.md.options.linkify) return;
	for (let j = 0, l = blockTokens.length; j < l; j++) {
		if (blockTokens[j].type !== "inline" || !state.md.linkify.pretest(blockTokens[j].content)) continue;
		let tokens = blockTokens[j].children;
		let htmlLinkLevel = 0;
		for (let i = tokens.length - 1; i >= 0; i--) {
			const currentToken = tokens[i];
			if (currentToken.type === "link_close") {
				i--;
				while (tokens[i].level !== currentToken.level && tokens[i].type !== "link_open") i--;
				continue;
			}
			if (currentToken.type === "html_inline") {
				if (isLinkOpen$1(currentToken.content) && htmlLinkLevel > 0) htmlLinkLevel--;
				if (isLinkClose$1(currentToken.content)) htmlLinkLevel++;
			}
			if (htmlLinkLevel > 0) continue;
			if (currentToken.type === "text" && state.md.linkify.test(currentToken.content)) {
				const text = currentToken.content;
				let links = state.md.linkify.match(text);
				const nodes = [];
				let level = currentToken.level;
				let lastPos = 0;
				if (links.length > 0 && links[0].index === 0 && i > 0 && tokens[i - 1].type === "text_special") links = links.slice(1);
				for (let ln = 0; ln < links.length; ln++) {
					const url = links[ln].url;
					const fullUrl = state.md.normalizeLink(url);
					if (!state.md.validateLink(fullUrl)) continue;
					let urlText = links[ln].text;
					if (!links[ln].schema) urlText = state.md.normalizeLinkText("http://" + urlText).replace(/^http:\/\//, "");
					else if (links[ln].schema === "mailto:" && !/^mailto:/i.test(urlText)) urlText = state.md.normalizeLinkText("mailto:" + urlText).replace(/^mailto:/, "");
					else urlText = state.md.normalizeLinkText(urlText);
					const pos = links[ln].index;
					if (pos > lastPos) {
						const token = new state.Token("text", "", 0);
						token.content = text.slice(lastPos, pos);
						token.level = level;
						nodes.push(token);
					}
					const token_o = new state.Token("link_open", "a", 1);
					token_o.attrs = [["href", fullUrl]];
					token_o.level = level++;
					token_o.markup = "linkify";
					token_o.info = "auto";
					nodes.push(token_o);
					const token_t = new state.Token("text", "", 0);
					token_t.content = urlText;
					token_t.level = level;
					nodes.push(token_t);
					const token_c = new state.Token("link_close", "a", -1);
					token_c.level = --level;
					token_c.markup = "linkify";
					token_c.info = "auto";
					nodes.push(token_c);
					lastPos = links[ln].lastIndex;
				}
				if (lastPos < text.length) {
					const token = new state.Token("text", "", 0);
					token.content = text.slice(lastPos);
					token.level = level;
					nodes.push(token);
				}
				blockTokens[j].children = tokens = arrayReplaceAt(tokens, i, nodes);
			}
		}
	}
}
const RARE_RE = /\+-|\.\.|\?\?\?\?|!!!!|,,|--/;
const SCOPED_ABBR_TEST_RE = /\((c|tm|r)\)/i;
const SCOPED_ABBR_RE = /\((c|tm|r)\)/gi;
const SCOPED_ABBR = {
	c: "©",
	r: "®",
	tm: "™"
};
function replaceFn(match, name) {
	return SCOPED_ABBR[name.toLowerCase()];
}
function replace_scoped(inlineTokens) {
	let inside_autolink = 0;
	for (let i = inlineTokens.length - 1; i >= 0; i--) {
		const token = inlineTokens[i];
		if (token.type === "text" && !inside_autolink) token.content = token.content.replace(SCOPED_ABBR_RE, replaceFn);
		if (token.type === "link_open" && token.info === "auto") inside_autolink--;
		if (token.type === "link_close" && token.info === "auto") inside_autolink++;
	}
}
function replace_rare(inlineTokens) {
	let inside_autolink = 0;
	for (let i = inlineTokens.length - 1; i >= 0; i--) {
		const token = inlineTokens[i];
		if (token.type === "text" && !inside_autolink) {
			if (RARE_RE.test(token.content)) token.content = token.content.replace(/\+-/g, "±").replace(/\.{2,}/g, "…").replace(/([?!])…/g, "$1..").replace(/([?!]){4,}/g, "$1$1$1").replace(/,{2,}/g, ",").replace(/(^|[^-])---(?=[^-]|$)/gm, "$1—").replace(/(^|\s)--(?=\s|$)/gm, "$1–").replace(/(^|[^-\s])--(?=[^-\s]|$)/gm, "$1–");
		}
		if (token.type === "link_open" && token.info === "auto") inside_autolink--;
		if (token.type === "link_close" && token.info === "auto") inside_autolink++;
	}
}
function replace(state) {
	let blkIdx;
	if (!state.md.options.typographer) return;
	for (blkIdx = state.tokens.length - 1; blkIdx >= 0; blkIdx--) {
		if (state.tokens[blkIdx].type !== "inline") continue;
		if (SCOPED_ABBR_TEST_RE.test(state.tokens[blkIdx].content)) replace_scoped(state.tokens[blkIdx].children);
		if (RARE_RE.test(state.tokens[blkIdx].content)) replace_rare(state.tokens[blkIdx].children);
	}
}
const QUOTE_TEST_RE = /['"]/;
const QUOTE_RE = /['"]/g;
const APOSTROPHE = "’";
function replaceAt(str, index, ch) {
	return str.slice(0, index) + ch + str.slice(index + 1);
}
function process_inlines(tokens, state) {
	let j;
	const stack = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const thisLevel = tokens[i].level;
		for (j = stack.length - 1; j >= 0; j--) if (stack[j].level <= thisLevel) break;
		stack.length = j + 1;
		if (token.type !== "text") continue;
		let text = token.content;
		let pos = 0;
		let max = text.length;
		OUTER: while (pos < max) {
			QUOTE_RE.lastIndex = pos;
			const t = QUOTE_RE.exec(text);
			if (!t) break;
			let canOpen = true;
			let canClose = true;
			pos = t.index + 1;
			const isSingle = t[0] === "'";
			let lastChar = 32;
			if (t.index - 1 >= 0) lastChar = text.charCodeAt(t.index - 1);
			else for (j = i - 1; j >= 0; j--) {
				if (tokens[j].type === "softbreak" || tokens[j].type === "hardbreak") break;
				if (!tokens[j].content) continue;
				lastChar = tokens[j].content.charCodeAt(tokens[j].content.length - 1);
				break;
			}
			let nextChar = 32;
			if (pos < max) nextChar = text.charCodeAt(pos);
			else for (j = i + 1; j < tokens.length; j++) {
				if (tokens[j].type === "softbreak" || tokens[j].type === "hardbreak") break;
				if (!tokens[j].content) continue;
				nextChar = tokens[j].content.charCodeAt(0);
				break;
			}
			const isLastPunctChar = isMdAsciiPunct(lastChar) || isPunctChar(String.fromCharCode(lastChar));
			const isNextPunctChar = isMdAsciiPunct(nextChar) || isPunctChar(String.fromCharCode(nextChar));
			const isLastWhiteSpace = isWhiteSpace(lastChar);
			const isNextWhiteSpace = isWhiteSpace(nextChar);
			if (isNextWhiteSpace) canOpen = false;
			else if (isNextPunctChar) {
				if (!(isLastWhiteSpace || isLastPunctChar)) canOpen = false;
			}
			if (isLastWhiteSpace) canClose = false;
			else if (isLastPunctChar) {
				if (!(isNextWhiteSpace || isNextPunctChar)) canClose = false;
			}
			if (nextChar === 34 && t[0] === "\"") {
				if (lastChar >= 48 && lastChar <= 57) canClose = canOpen = false;
			}
			if (canOpen && canClose) {
				canOpen = isLastPunctChar;
				canClose = isNextPunctChar;
			}
			if (!canOpen && !canClose) {
				if (isSingle) token.content = replaceAt(token.content, t.index, APOSTROPHE);
				continue;
			}
			if (canClose) for (j = stack.length - 1; j >= 0; j--) {
				let item = stack[j];
				if (stack[j].level < thisLevel) break;
				if (item.single === isSingle && stack[j].level === thisLevel) {
					item = stack[j];
					let openQuote;
					let closeQuote;
					if (isSingle) {
						openQuote = state.md.options.quotes[2];
						closeQuote = state.md.options.quotes[3];
					} else {
						openQuote = state.md.options.quotes[0];
						closeQuote = state.md.options.quotes[1];
					}
					token.content = replaceAt(token.content, t.index, closeQuote);
					tokens[item.token].content = replaceAt(tokens[item.token].content, item.pos, openQuote);
					pos += closeQuote.length - 1;
					if (item.token === i) pos += openQuote.length - 1;
					text = token.content;
					max = text.length;
					stack.length = j;
					continue OUTER;
				}
			}
			if (canOpen) stack.push({
				token: i,
				pos: t.index,
				single: isSingle,
				level: thisLevel
			});
			else if (canClose && isSingle) token.content = replaceAt(token.content, t.index, APOSTROPHE);
		}
	}
}
function smartquotes(state) {
	if (!state.md.options.typographer) return;
	for (let blkIdx = state.tokens.length - 1; blkIdx >= 0; blkIdx--) {
		if (state.tokens[blkIdx].type !== "inline" || !QUOTE_TEST_RE.test(state.tokens[blkIdx].content)) continue;
		process_inlines(state.tokens[blkIdx].children, state);
	}
}
function text_join(state) {
	let curr, last;
	const blockTokens = state.tokens;
	const l = blockTokens.length;
	for (let j = 0; j < l; j++) {
		if (blockTokens[j].type !== "inline") continue;
		const tokens = blockTokens[j].children;
		const max = tokens.length;
		for (curr = 0; curr < max; curr++) if (tokens[curr].type === "text_special") tokens[curr].type = "text";
		for (curr = last = 0; curr < max; curr++) if (tokens[curr].type === "text" && curr + 1 < max && tokens[curr + 1].type === "text") tokens[curr + 1].content = tokens[curr].content + tokens[curr + 1].content;
		else {
			if (curr !== last) tokens[last] = tokens[curr];
			last++;
		}
		if (curr !== last) tokens.length = last;
	}
}
/** internal
* class Core
*
* Top-level rules executor. Glues block/inline parsers and does intermediate
* transformations.
**/
const _rules$2 = [
	["normalize", normalize],
	["block", block],
	["inline", inline],
	["linkify", linkify$1],
	["replacements", replace],
	["smartquotes", smartquotes],
	["text_join", text_join]
];
/**
* new Core()
**/
function Core() {
	/**
	* Core#ruler -> Ruler
	*
	* [[Ruler]] instance. Keep configuration of core rules.
	**/
	this.ruler = new Ruler();
	for (let i = 0; i < _rules$2.length; i++) this.ruler.push(_rules$2[i][0], _rules$2[i][1]);
}
/**
* Core.process(state)
*
* Executes core chain rules.
**/
Core.prototype.process = function(state) {
	const rules = this.ruler.getRules("");
	for (let i = 0, l = rules.length; i < l; i++) rules[i](state);
};
Core.prototype.State = StateCore;
function StateBlock(src, md, env, tokens) {
	this.src = src;
	this.md = md;
	this.env = env;
	this.tokens = tokens;
	this.bMarks = [];
	this.eMarks = [];
	this.tShift = [];
	this.sCount = [];
	this.bsCount = [];
	this.blkIndent = 0;
	this.line = 0;
	this.lineMax = 0;
	this.tight = false;
	this.ddIndent = -1;
	this.listIndent = -1;
	this.parentType = "root";
	this.level = 0;
	const s = this.src;
	for (let start = 0, pos = 0, indent = 0, offset = 0, len = s.length, indent_found = false; pos < len; pos++) {
		const ch = s.charCodeAt(pos);
		if (!indent_found) if (isSpace(ch)) {
			indent++;
			if (ch === 9) offset += 4 - offset % 4;
			else offset++;
			continue;
		} else indent_found = true;
		if (ch === 10 || pos === len - 1) {
			if (ch !== 10) pos++;
			this.bMarks.push(start);
			this.eMarks.push(pos);
			this.tShift.push(indent);
			this.sCount.push(offset);
			this.bsCount.push(0);
			indent_found = false;
			indent = 0;
			offset = 0;
			start = pos + 1;
		}
	}
	this.bMarks.push(s.length);
	this.eMarks.push(s.length);
	this.tShift.push(0);
	this.sCount.push(0);
	this.bsCount.push(0);
	this.lineMax = this.bMarks.length - 1;
}
StateBlock.prototype.push = function(type, tag, nesting) {
	const token = new Token(type, tag, nesting);
	token.block = true;
	if (nesting < 0) this.level--;
	token.level = this.level;
	if (nesting > 0) this.level++;
	this.tokens.push(token);
	return token;
};
StateBlock.prototype.isEmpty = function isEmpty(line) {
	return this.bMarks[line] + this.tShift[line] >= this.eMarks[line];
};
StateBlock.prototype.skipEmptyLines = function skipEmptyLines(from) {
	for (let max = this.lineMax; from < max; from++) if (this.bMarks[from] + this.tShift[from] < this.eMarks[from]) break;
	return from;
};
StateBlock.prototype.skipSpaces = function skipSpaces(pos) {
	for (let max = this.src.length; pos < max; pos++) if (!isSpace(this.src.charCodeAt(pos))) break;
	return pos;
};
StateBlock.prototype.skipSpacesBack = function skipSpacesBack(pos, min) {
	if (pos <= min) return pos;
	while (pos > min) if (!isSpace(this.src.charCodeAt(--pos))) return pos + 1;
	return pos;
};
StateBlock.prototype.skipChars = function skipChars(pos, code) {
	for (let max = this.src.length; pos < max; pos++) if (this.src.charCodeAt(pos) !== code) break;
	return pos;
};
StateBlock.prototype.skipCharsBack = function skipCharsBack(pos, code, min) {
	if (pos <= min) return pos;
	while (pos > min) if (code !== this.src.charCodeAt(--pos)) return pos + 1;
	return pos;
};
StateBlock.prototype.getLines = function getLines(begin, end, indent, keepLastLF) {
	if (begin >= end) return "";
	const queue = new Array(end - begin);
	for (let i = 0, line = begin; line < end; line++, i++) {
		let lineIndent = 0;
		const lineStart = this.bMarks[line];
		let first = lineStart;
		let last;
		if (line + 1 < end || keepLastLF) last = this.eMarks[line] + 1;
		else last = this.eMarks[line];
		while (first < last && lineIndent < indent) {
			const ch = this.src.charCodeAt(first);
			if (isSpace(ch)) if (ch === 9) lineIndent += 4 - (lineIndent + this.bsCount[line]) % 4;
			else lineIndent++;
			else if (first - lineStart < this.tShift[line]) lineIndent++;
			else break;
			first++;
		}
		if (lineIndent > indent) queue[i] = new Array(lineIndent - indent + 1).join(" ") + this.src.slice(first, last);
		else queue[i] = this.src.slice(first, last);
	}
	return queue.join("");
};
StateBlock.prototype.Token = Token;
const MAX_AUTOCOMPLETED_CELLS = 65536;
function getLine(state, line) {
	const pos = state.bMarks[line] + state.tShift[line];
	const max = state.eMarks[line];
	return state.src.slice(pos, max);
}
function escapedSplit(str) {
	const result = [];
	const max = str.length;
	let pos = 0;
	let ch = str.charCodeAt(pos);
	let isEscaped = false;
	let lastPos = 0;
	let current = "";
	while (pos < max) {
		if (ch === 124) if (!isEscaped) {
			result.push(current + str.substring(lastPos, pos));
			current = "";
			lastPos = pos + 1;
		} else {
			current += str.substring(lastPos, pos - 1);
			lastPos = pos;
		}
		isEscaped = ch === 92;
		pos++;
		ch = str.charCodeAt(pos);
	}
	result.push(current + str.substring(lastPos));
	return result;
}
function table(state, startLine, endLine, silent) {
	if (startLine + 2 > endLine) return false;
	let nextLine = startLine + 1;
	if (state.sCount[nextLine] < state.blkIndent) return false;
	if (state.sCount[nextLine] - state.blkIndent >= 4) return false;
	let pos = state.bMarks[nextLine] + state.tShift[nextLine];
	if (pos >= state.eMarks[nextLine]) return false;
	const firstCh = state.src.charCodeAt(pos++);
	if (firstCh !== 124 && firstCh !== 45 && firstCh !== 58) return false;
	if (pos >= state.eMarks[nextLine]) return false;
	const secondCh = state.src.charCodeAt(pos++);
	if (secondCh !== 124 && secondCh !== 45 && secondCh !== 58 && !isSpace(secondCh)) return false;
	if (firstCh === 45 && isSpace(secondCh)) return false;
	while (pos < state.eMarks[nextLine]) {
		const ch = state.src.charCodeAt(pos);
		if (ch !== 124 && ch !== 45 && ch !== 58 && !isSpace(ch)) return false;
		pos++;
	}
	let lineText = getLine(state, startLine + 1);
	let columns = lineText.split("|");
	const aligns = [];
	for (let i = 0; i < columns.length; i++) {
		const t = columns[i].trim();
		if (!t) if (i === 0 || i === columns.length - 1) continue;
		else return false;
		if (!/^:?-+:?$/.test(t)) return false;
		if (t.charCodeAt(t.length - 1) === 58) aligns.push(t.charCodeAt(0) === 58 ? "center" : "right");
		else if (t.charCodeAt(0) === 58) aligns.push("left");
		else aligns.push("");
	}
	lineText = getLine(state, startLine).trim();
	if (lineText.indexOf("|") === -1) return false;
	if (state.sCount[startLine] - state.blkIndent >= 4) return false;
	columns = escapedSplit(lineText);
	if (columns.length && columns[0] === "") columns.shift();
	if (columns.length && columns[columns.length - 1] === "") columns.pop();
	const columnCount = columns.length;
	if (columnCount === 0 || columnCount !== aligns.length) return false;
	if (silent) return true;
	const oldParentType = state.parentType;
	state.parentType = "table";
	const terminatorRules = state.md.block.ruler.getRules("blockquote");
	const token_to = state.push("table_open", "table", 1);
	const tableLines = [startLine, 0];
	token_to.map = tableLines;
	const token_tho = state.push("thead_open", "thead", 1);
	token_tho.map = [startLine, startLine + 1];
	const token_htro = state.push("tr_open", "tr", 1);
	token_htro.map = [startLine, startLine + 1];
	for (let i = 0; i < columns.length; i++) {
		const token_ho = state.push("th_open", "th", 1);
		if (aligns[i]) token_ho.attrs = [["style", "text-align:" + aligns[i]]];
		const token_il = state.push("inline", "", 0);
		token_il.content = columns[i].trim();
		token_il.children = [];
		state.push("th_close", "th", -1);
	}
	state.push("tr_close", "tr", -1);
	state.push("thead_close", "thead", -1);
	let tbodyLines;
	let autocompletedCells = 0;
	for (nextLine = startLine + 2; nextLine < endLine; nextLine++) {
		if (state.sCount[nextLine] < state.blkIndent) break;
		let terminate = false;
		for (let i = 0, l = terminatorRules.length; i < l; i++) if (terminatorRules[i](state, nextLine, endLine, true)) {
			terminate = true;
			break;
		}
		if (terminate) break;
		lineText = getLine(state, nextLine).trim();
		if (!lineText) break;
		if (state.sCount[nextLine] - state.blkIndent >= 4) break;
		columns = escapedSplit(lineText);
		if (columns.length && columns[0] === "") columns.shift();
		if (columns.length && columns[columns.length - 1] === "") columns.pop();
		autocompletedCells += columnCount - columns.length;
		if (autocompletedCells > MAX_AUTOCOMPLETED_CELLS) break;
		if (nextLine === startLine + 2) {
			const token_tbo = state.push("tbody_open", "tbody", 1);
			token_tbo.map = tbodyLines = [startLine + 2, 0];
		}
		const token_tro = state.push("tr_open", "tr", 1);
		token_tro.map = [nextLine, nextLine + 1];
		for (let i = 0; i < columnCount; i++) {
			const token_tdo = state.push("td_open", "td", 1);
			if (aligns[i]) token_tdo.attrs = [["style", "text-align:" + aligns[i]]];
			const token_il = state.push("inline", "", 0);
			token_il.content = columns[i] ? columns[i].trim() : "";
			token_il.children = [];
			state.push("td_close", "td", -1);
		}
		state.push("tr_close", "tr", -1);
	}
	if (tbodyLines) {
		state.push("tbody_close", "tbody", -1);
		tbodyLines[1] = nextLine;
	}
	state.push("table_close", "table", -1);
	tableLines[1] = nextLine;
	state.parentType = oldParentType;
	state.line = nextLine;
	return true;
}
function code(state, startLine, endLine) {
	if (state.sCount[startLine] - state.blkIndent < 4) return false;
	let nextLine = startLine + 1;
	let last = nextLine;
	while (nextLine < endLine) {
		if (state.isEmpty(nextLine)) {
			nextLine++;
			continue;
		}
		if (state.sCount[nextLine] - state.blkIndent >= 4) {
			nextLine++;
			last = nextLine;
			continue;
		}
		break;
	}
	state.line = last;
	const token = state.push("code_block", "code", 0);
	token.content = state.getLines(startLine, last, 4 + state.blkIndent, false) + "\n";
	token.map = [startLine, state.line];
	return true;
}
function fence(state, startLine, endLine, silent) {
	let pos = state.bMarks[startLine] + state.tShift[startLine];
	let max = state.eMarks[startLine];
	if (state.sCount[startLine] - state.blkIndent >= 4) return false;
	if (pos + 3 > max) return false;
	const marker = state.src.charCodeAt(pos);
	if (marker !== 126 && marker !== 96) return false;
	let mem = pos;
	pos = state.skipChars(pos, marker);
	let len = pos - mem;
	if (len < 3) return false;
	const markup = state.src.slice(mem, pos);
	const params = state.src.slice(pos, max);
	if (marker === 96) {
		if (params.indexOf(String.fromCharCode(marker)) >= 0) return false;
	}
	if (silent) return true;
	let nextLine = startLine;
	let haveEndMarker = false;
	for (;;) {
		nextLine++;
		if (nextLine >= endLine) break;
		pos = mem = state.bMarks[nextLine] + state.tShift[nextLine];
		max = state.eMarks[nextLine];
		if (pos < max && state.sCount[nextLine] < state.blkIndent) break;
		if (state.src.charCodeAt(pos) !== marker) continue;
		if (state.sCount[nextLine] - state.blkIndent >= 4) continue;
		pos = state.skipChars(pos, marker);
		if (pos - mem < len) continue;
		pos = state.skipSpaces(pos);
		if (pos < max) continue;
		haveEndMarker = true;
		break;
	}
	len = state.sCount[startLine];
	state.line = nextLine + (haveEndMarker ? 1 : 0);
	const token = state.push("fence", "code", 0);
	token.info = params;
	token.content = state.getLines(startLine + 1, nextLine, len, true);
	token.markup = markup;
	token.map = [startLine, state.line];
	return true;
}
function blockquote(state, startLine, endLine, silent) {
	let pos = state.bMarks[startLine] + state.tShift[startLine];
	let max = state.eMarks[startLine];
	const oldLineMax = state.lineMax;
	if (state.sCount[startLine] - state.blkIndent >= 4) return false;
	if (state.src.charCodeAt(pos) !== 62) return false;
	if (silent) return true;
	const oldBMarks = [];
	const oldBSCount = [];
	const oldSCount = [];
	const oldTShift = [];
	const terminatorRules = state.md.block.ruler.getRules("blockquote");
	const oldParentType = state.parentType;
	state.parentType = "blockquote";
	let lastLineEmpty = false;
	let nextLine;
	for (nextLine = startLine; nextLine < endLine; nextLine++) {
		const isOutdented = state.sCount[nextLine] < state.blkIndent;
		pos = state.bMarks[nextLine] + state.tShift[nextLine];
		max = state.eMarks[nextLine];
		if (pos >= max) break;
		if (state.src.charCodeAt(pos++) === 62 && !isOutdented) {
			let initial = state.sCount[nextLine] + 1;
			let spaceAfterMarker;
			let adjustTab;
			if (state.src.charCodeAt(pos) === 32) {
				pos++;
				initial++;
				adjustTab = false;
				spaceAfterMarker = true;
			} else if (state.src.charCodeAt(pos) === 9) {
				spaceAfterMarker = true;
				if ((state.bsCount[nextLine] + initial) % 4 === 3) {
					pos++;
					initial++;
					adjustTab = false;
				} else adjustTab = true;
			} else spaceAfterMarker = false;
			let offset = initial;
			oldBMarks.push(state.bMarks[nextLine]);
			state.bMarks[nextLine] = pos;
			while (pos < max) {
				const ch = state.src.charCodeAt(pos);
				if (isSpace(ch)) if (ch === 9) offset += 4 - (offset + state.bsCount[nextLine] + (adjustTab ? 1 : 0)) % 4;
				else offset++;
				else break;
				pos++;
			}
			lastLineEmpty = pos >= max;
			oldBSCount.push(state.bsCount[nextLine]);
			state.bsCount[nextLine] = state.sCount[nextLine] + 1 + (spaceAfterMarker ? 1 : 0);
			oldSCount.push(state.sCount[nextLine]);
			state.sCount[nextLine] = offset - initial;
			oldTShift.push(state.tShift[nextLine]);
			state.tShift[nextLine] = pos - state.bMarks[nextLine];
			continue;
		}
		if (lastLineEmpty) break;
		let terminate = false;
		for (let i = 0, l = terminatorRules.length; i < l; i++) if (terminatorRules[i](state, nextLine, endLine, true)) {
			terminate = true;
			break;
		}
		if (terminate) {
			state.lineMax = nextLine;
			if (state.blkIndent !== 0) {
				oldBMarks.push(state.bMarks[nextLine]);
				oldBSCount.push(state.bsCount[nextLine]);
				oldTShift.push(state.tShift[nextLine]);
				oldSCount.push(state.sCount[nextLine]);
				state.sCount[nextLine] -= state.blkIndent;
			}
			break;
		}
		oldBMarks.push(state.bMarks[nextLine]);
		oldBSCount.push(state.bsCount[nextLine]);
		oldTShift.push(state.tShift[nextLine]);
		oldSCount.push(state.sCount[nextLine]);
		state.sCount[nextLine] = -1;
	}
	const oldIndent = state.blkIndent;
	state.blkIndent = 0;
	const token_o = state.push("blockquote_open", "blockquote", 1);
	token_o.markup = ">";
	const lines = [startLine, 0];
	token_o.map = lines;
	state.md.block.tokenize(state, startLine, nextLine);
	const token_c = state.push("blockquote_close", "blockquote", -1);
	token_c.markup = ">";
	state.lineMax = oldLineMax;
	state.parentType = oldParentType;
	lines[1] = state.line;
	for (let i = 0; i < oldTShift.length; i++) {
		state.bMarks[i + startLine] = oldBMarks[i];
		state.tShift[i + startLine] = oldTShift[i];
		state.sCount[i + startLine] = oldSCount[i];
		state.bsCount[i + startLine] = oldBSCount[i];
	}
	state.blkIndent = oldIndent;
	return true;
}
function hr(state, startLine, endLine, silent) {
	const max = state.eMarks[startLine];
	if (state.sCount[startLine] - state.blkIndent >= 4) return false;
	let pos = state.bMarks[startLine] + state.tShift[startLine];
	const marker = state.src.charCodeAt(pos++);
	if (marker !== 42 && marker !== 45 && marker !== 95) return false;
	let cnt = 1;
	while (pos < max) {
		const ch = state.src.charCodeAt(pos++);
		if (ch !== marker && !isSpace(ch)) return false;
		if (ch === marker) cnt++;
	}
	if (cnt < 3) return false;
	if (silent) return true;
	state.line = startLine + 1;
	const token = state.push("hr", "hr", 0);
	token.map = [startLine, state.line];
	token.markup = Array(cnt + 1).join(String.fromCharCode(marker));
	return true;
}
function skipBulletListMarker(state, startLine) {
	const max = state.eMarks[startLine];
	let pos = state.bMarks[startLine] + state.tShift[startLine];
	const marker = state.src.charCodeAt(pos++);
	if (marker !== 42 && marker !== 45 && marker !== 43) return -1;
	if (pos < max) {
		if (!isSpace(state.src.charCodeAt(pos))) return -1;
	}
	return pos;
}
function skipOrderedListMarker(state, startLine) {
	const start = state.bMarks[startLine] + state.tShift[startLine];
	const max = state.eMarks[startLine];
	let pos = start;
	if (pos + 1 >= max) return -1;
	let ch = state.src.charCodeAt(pos++);
	if (ch < 48 || ch > 57) return -1;
	for (;;) {
		if (pos >= max) return -1;
		ch = state.src.charCodeAt(pos++);
		if (ch >= 48 && ch <= 57) {
			if (pos - start >= 10) return -1;
			continue;
		}
		if (ch === 41 || ch === 46) break;
		return -1;
	}
	if (pos < max) {
		ch = state.src.charCodeAt(pos);
		if (!isSpace(ch)) return -1;
	}
	return pos;
}
function markTightParagraphs(state, idx) {
	const level = state.level + 2;
	for (let i = idx + 2, l = state.tokens.length - 2; i < l; i++) if (state.tokens[i].level === level && state.tokens[i].type === "paragraph_open") {
		state.tokens[i + 2].hidden = true;
		state.tokens[i].hidden = true;
		i += 2;
	}
}
function list(state, startLine, endLine, silent) {
	let max, pos, start, token;
	let nextLine = startLine;
	let tight = true;
	if (state.sCount[nextLine] - state.blkIndent >= 4) return false;
	if (state.listIndent >= 0 && state.sCount[nextLine] - state.listIndent >= 4 && state.sCount[nextLine] < state.blkIndent) return false;
	let isTerminatingParagraph = false;
	if (silent && state.parentType === "paragraph") {
		if (state.sCount[nextLine] >= state.blkIndent) isTerminatingParagraph = true;
	}
	let isOrdered;
	let markerValue;
	let posAfterMarker;
	if ((posAfterMarker = skipOrderedListMarker(state, nextLine)) >= 0) {
		isOrdered = true;
		start = state.bMarks[nextLine] + state.tShift[nextLine];
		markerValue = Number(state.src.slice(start, posAfterMarker - 1));
		if (isTerminatingParagraph && markerValue !== 1) return false;
	} else if ((posAfterMarker = skipBulletListMarker(state, nextLine)) >= 0) isOrdered = false;
	else return false;
	if (isTerminatingParagraph) {
		if (state.skipSpaces(posAfterMarker) >= state.eMarks[nextLine]) return false;
	}
	if (silent) return true;
	const markerCharCode = state.src.charCodeAt(posAfterMarker - 1);
	const listTokIdx = state.tokens.length;
	if (isOrdered) {
		token = state.push("ordered_list_open", "ol", 1);
		if (markerValue !== 1) token.attrs = [["start", markerValue]];
	} else token = state.push("bullet_list_open", "ul", 1);
	const listLines = [nextLine, 0];
	token.map = listLines;
	token.markup = String.fromCharCode(markerCharCode);
	let prevEmptyEnd = false;
	const terminatorRules = state.md.block.ruler.getRules("list");
	const oldParentType = state.parentType;
	state.parentType = "list";
	while (nextLine < endLine) {
		pos = posAfterMarker;
		max = state.eMarks[nextLine];
		const initial = state.sCount[nextLine] + posAfterMarker - (state.bMarks[nextLine] + state.tShift[nextLine]);
		let offset = initial;
		while (pos < max) {
			const ch = state.src.charCodeAt(pos);
			if (ch === 9) offset += 4 - (offset + state.bsCount[nextLine]) % 4;
			else if (ch === 32) offset++;
			else break;
			pos++;
		}
		const contentStart = pos;
		let indentAfterMarker;
		if (contentStart >= max) indentAfterMarker = 1;
		else indentAfterMarker = offset - initial;
		if (indentAfterMarker > 4) indentAfterMarker = 1;
		const indent = initial + indentAfterMarker;
		token = state.push("list_item_open", "li", 1);
		token.markup = String.fromCharCode(markerCharCode);
		const itemLines = [nextLine, 0];
		token.map = itemLines;
		if (isOrdered) token.info = state.src.slice(start, posAfterMarker - 1);
		const oldTight = state.tight;
		const oldTShift = state.tShift[nextLine];
		const oldSCount = state.sCount[nextLine];
		const oldListIndent = state.listIndent;
		state.listIndent = state.blkIndent;
		state.blkIndent = indent;
		state.tight = true;
		state.tShift[nextLine] = contentStart - state.bMarks[nextLine];
		state.sCount[nextLine] = offset;
		if (contentStart >= max && state.isEmpty(nextLine + 1)) state.line = Math.min(state.line + 2, endLine);
		else state.md.block.tokenize(state, nextLine, endLine, true);
		if (!state.tight || prevEmptyEnd) tight = false;
		prevEmptyEnd = state.line - nextLine > 1 && state.isEmpty(state.line - 1);
		state.blkIndent = state.listIndent;
		state.listIndent = oldListIndent;
		state.tShift[nextLine] = oldTShift;
		state.sCount[nextLine] = oldSCount;
		state.tight = oldTight;
		token = state.push("list_item_close", "li", -1);
		token.markup = String.fromCharCode(markerCharCode);
		nextLine = state.line;
		itemLines[1] = nextLine;
		if (nextLine >= endLine) break;
		if (state.sCount[nextLine] < state.blkIndent) break;
		if (state.sCount[nextLine] - state.blkIndent >= 4) break;
		let terminate = false;
		for (let i = 0, l = terminatorRules.length; i < l; i++) if (terminatorRules[i](state, nextLine, endLine, true)) {
			terminate = true;
			break;
		}
		if (terminate) break;
		if (isOrdered) {
			posAfterMarker = skipOrderedListMarker(state, nextLine);
			if (posAfterMarker < 0) break;
			start = state.bMarks[nextLine] + state.tShift[nextLine];
		} else {
			posAfterMarker = skipBulletListMarker(state, nextLine);
			if (posAfterMarker < 0) break;
		}
		if (markerCharCode !== state.src.charCodeAt(posAfterMarker - 1)) break;
	}
	if (isOrdered) token = state.push("ordered_list_close", "ol", -1);
	else token = state.push("bullet_list_close", "ul", -1);
	token.markup = String.fromCharCode(markerCharCode);
	listLines[1] = nextLine;
	state.line = nextLine;
	state.parentType = oldParentType;
	if (tight) markTightParagraphs(state, listTokIdx);
	return true;
}
function reference(state, startLine, _endLine, silent) {
	let pos = state.bMarks[startLine] + state.tShift[startLine];
	let max = state.eMarks[startLine];
	let nextLine = startLine + 1;
	if (state.sCount[startLine] - state.blkIndent >= 4) return false;
	if (state.src.charCodeAt(pos) !== 91) return false;
	function getNextLine(nextLine) {
		const endLine = state.lineMax;
		if (nextLine >= endLine || state.isEmpty(nextLine)) return null;
		let isContinuation = false;
		if (state.sCount[nextLine] - state.blkIndent > 3) isContinuation = true;
		if (state.sCount[nextLine] < 0) isContinuation = true;
		if (!isContinuation) {
			const terminatorRules = state.md.block.ruler.getRules("reference");
			const oldParentType = state.parentType;
			state.parentType = "reference";
			let terminate = false;
			for (let i = 0, l = terminatorRules.length; i < l; i++) if (terminatorRules[i](state, nextLine, endLine, true)) {
				terminate = true;
				break;
			}
			state.parentType = oldParentType;
			if (terminate) return null;
		}
		const pos = state.bMarks[nextLine] + state.tShift[nextLine];
		const max = state.eMarks[nextLine];
		return state.src.slice(pos, max + 1);
	}
	let str = state.src.slice(pos, max + 1);
	max = str.length;
	let labelEnd = -1;
	for (pos = 1; pos < max; pos++) {
		const ch = str.charCodeAt(pos);
		if (ch === 91) return false;
		else if (ch === 93) {
			labelEnd = pos;
			break;
		} else if (ch === 10) {
			const lineContent = getNextLine(nextLine);
			if (lineContent !== null) {
				str += lineContent;
				max = str.length;
				nextLine++;
			}
		} else if (ch === 92) {
			pos++;
			if (pos < max && str.charCodeAt(pos) === 10) {
				const lineContent = getNextLine(nextLine);
				if (lineContent !== null) {
					str += lineContent;
					max = str.length;
					nextLine++;
				}
			}
		}
	}
	if (labelEnd < 0 || str.charCodeAt(labelEnd + 1) !== 58) return false;
	for (pos = labelEnd + 2; pos < max; pos++) {
		const ch = str.charCodeAt(pos);
		if (ch === 10) {
			const lineContent = getNextLine(nextLine);
			if (lineContent !== null) {
				str += lineContent;
				max = str.length;
				nextLine++;
			}
		} else if (isSpace(ch)) {} else break;
	}
	const destRes = state.md.helpers.parseLinkDestination(str, pos, max);
	if (!destRes.ok) return false;
	const href = state.md.normalizeLink(destRes.str);
	if (!state.md.validateLink(href)) return false;
	pos = destRes.pos;
	const destEndPos = pos;
	const destEndLineNo = nextLine;
	const start = pos;
	for (; pos < max; pos++) {
		const ch = str.charCodeAt(pos);
		if (ch === 10) {
			const lineContent = getNextLine(nextLine);
			if (lineContent !== null) {
				str += lineContent;
				max = str.length;
				nextLine++;
			}
		} else if (isSpace(ch)) {} else break;
	}
	let titleRes = state.md.helpers.parseLinkTitle(str, pos, max);
	while (titleRes.can_continue) {
		const lineContent = getNextLine(nextLine);
		if (lineContent === null) break;
		str += lineContent;
		pos = max;
		max = str.length;
		nextLine++;
		titleRes = state.md.helpers.parseLinkTitle(str, pos, max, titleRes);
	}
	let title;
	if (pos < max && start !== pos && titleRes.ok) {
		title = titleRes.str;
		pos = titleRes.pos;
	} else {
		title = "";
		pos = destEndPos;
		nextLine = destEndLineNo;
	}
	while (pos < max) {
		if (!isSpace(str.charCodeAt(pos))) break;
		pos++;
	}
	if (pos < max && str.charCodeAt(pos) !== 10) {
		if (title) {
			title = "";
			pos = destEndPos;
			nextLine = destEndLineNo;
			while (pos < max) {
				if (!isSpace(str.charCodeAt(pos))) break;
				pos++;
			}
		}
	}
	if (pos < max && str.charCodeAt(pos) !== 10) return false;
	const label = normalizeReference(str.slice(1, labelEnd));
	if (!label) return false;
	/* istanbul ignore if */
	if (silent) return true;
	if (typeof state.env.references === "undefined") state.env.references = {};
	if (typeof state.env.references[label] === "undefined") state.env.references[label] = {
		title,
		href
	};
	state.line = nextLine;
	return true;
}
var html_blocks_default = [
	"address",
	"article",
	"aside",
	"base",
	"basefont",
	"blockquote",
	"body",
	"caption",
	"center",
	"col",
	"colgroup",
	"dd",
	"details",
	"dialog",
	"dir",
	"div",
	"dl",
	"dt",
	"fieldset",
	"figcaption",
	"figure",
	"footer",
	"form",
	"frame",
	"frameset",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"head",
	"header",
	"hr",
	"html",
	"iframe",
	"legend",
	"li",
	"link",
	"main",
	"menu",
	"menuitem",
	"nav",
	"noframes",
	"ol",
	"optgroup",
	"option",
	"p",
	"param",
	"search",
	"section",
	"summary",
	"table",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"title",
	"tr",
	"track",
	"ul"
];
const open_tag = "<[A-Za-z][A-Za-z0-9\\-]*(?:\\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\\s*=\\s*(?:[^\"'=<>`\\x00-\\x20]+|'[^']*'|\"[^\"]*\"))?)*\\s*\\/?>";
const HTML_TAG_RE = new RegExp("^(?:" + open_tag + "|<\\/[A-Za-z][A-Za-z0-9\\-]*\\s*>|<!---?>|<!--(?:[^-]|-[^-]|--[^>])*-->|<[?][\\s\\S]*?[?]>|<![A-Za-z][^>]*>|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>)");
const HTML_OPEN_CLOSE_TAG_RE = new RegExp("^(?:" + open_tag + "|<\\/[A-Za-z][A-Za-z0-9\\-]*\\s*>)");
const HTML_SEQUENCES = [
	[
		/^<(script|pre|style|textarea)(?=(\s|>|$))/i,
		/<\/(script|pre|style|textarea)>/i,
		true
	],
	[
		/^<!--/,
		/-->/,
		true
	],
	[
		/^<\?/,
		/\?>/,
		true
	],
	[
		/^<![A-Z]/,
		/>/,
		true
	],
	[
		/^<!\[CDATA\[/,
		/\]\]>/,
		true
	],
	[
		new RegExp("^</?(" + html_blocks_default.join("|") + ")(?=(\\s|/?>|$))", "i"),
		/^$/,
		true
	],
	[
		new RegExp(HTML_OPEN_CLOSE_TAG_RE.source + "\\s*$"),
		/^$/,
		false
	]
];
function html_block(state, startLine, endLine, silent) {
	let pos = state.bMarks[startLine] + state.tShift[startLine];
	let max = state.eMarks[startLine];
	if (state.sCount[startLine] - state.blkIndent >= 4) return false;
	if (!state.md.options.html) return false;
	if (state.src.charCodeAt(pos) !== 60) return false;
	let lineText = state.src.slice(pos, max);
	let i = 0;
	for (; i < HTML_SEQUENCES.length; i++) if (HTML_SEQUENCES[i][0].test(lineText)) break;
	if (i === HTML_SEQUENCES.length) return false;
	if (silent) return HTML_SEQUENCES[i][2];
	let nextLine = startLine + 1;
	if (!HTML_SEQUENCES[i][1].test(lineText)) for (; nextLine < endLine; nextLine++) {
		if (state.sCount[nextLine] < state.blkIndent) break;
		pos = state.bMarks[nextLine] + state.tShift[nextLine];
		max = state.eMarks[nextLine];
		lineText = state.src.slice(pos, max);
		if (HTML_SEQUENCES[i][1].test(lineText)) {
			if (lineText.length !== 0) nextLine++;
			break;
		}
	}
	state.line = nextLine;
	const token = state.push("html_block", "", 0);
	token.map = [startLine, nextLine];
	token.content = state.getLines(startLine, nextLine, state.blkIndent, true);
	return true;
}
function heading(state, startLine, endLine, silent) {
	let pos = state.bMarks[startLine] + state.tShift[startLine];
	let max = state.eMarks[startLine];
	if (state.sCount[startLine] - state.blkIndent >= 4) return false;
	let ch = state.src.charCodeAt(pos);
	if (ch !== 35 || pos >= max) return false;
	let level = 1;
	ch = state.src.charCodeAt(++pos);
	while (ch === 35 && pos < max && level <= 6) {
		level++;
		ch = state.src.charCodeAt(++pos);
	}
	if (level > 6 || pos < max && !isSpace(ch)) return false;
	if (silent) return true;
	max = state.skipSpacesBack(max, pos);
	const tmp = state.skipCharsBack(max, 35, pos);
	if (tmp > pos && isSpace(state.src.charCodeAt(tmp - 1))) max = tmp;
	state.line = startLine + 1;
	const token_o = state.push("heading_open", "h" + String(level), 1);
	token_o.markup = "########".slice(0, level);
	token_o.map = [startLine, state.line];
	const token_i = state.push("inline", "", 0);
	token_i.content = state.src.slice(pos, max).trim();
	token_i.map = [startLine, state.line];
	token_i.children = [];
	const token_c = state.push("heading_close", "h" + String(level), -1);
	token_c.markup = "########".slice(0, level);
	return true;
}
function lheading(state, startLine, endLine) {
	const terminatorRules = state.md.block.ruler.getRules("paragraph");
	if (state.sCount[startLine] - state.blkIndent >= 4) return false;
	const oldParentType = state.parentType;
	state.parentType = "paragraph";
	let level = 0;
	let marker;
	let nextLine = startLine + 1;
	for (; nextLine < endLine && !state.isEmpty(nextLine); nextLine++) {
		if (state.sCount[nextLine] - state.blkIndent > 3) continue;
		if (state.sCount[nextLine] >= state.blkIndent) {
			let pos = state.bMarks[nextLine] + state.tShift[nextLine];
			const max = state.eMarks[nextLine];
			if (pos < max) {
				marker = state.src.charCodeAt(pos);
				if (marker === 45 || marker === 61) {
					pos = state.skipChars(pos, marker);
					pos = state.skipSpaces(pos);
					if (pos >= max) {
						level = marker === 61 ? 1 : 2;
						break;
					}
				}
			}
		}
		if (state.sCount[nextLine] < 0) continue;
		let terminate = false;
		for (let i = 0, l = terminatorRules.length; i < l; i++) if (terminatorRules[i](state, nextLine, endLine, true)) {
			terminate = true;
			break;
		}
		if (terminate) break;
	}
	if (!level) return false;
	const content = state.getLines(startLine, nextLine, state.blkIndent, false).trim();
	state.line = nextLine + 1;
	const token_o = state.push("heading_open", "h" + String(level), 1);
	token_o.markup = String.fromCharCode(marker);
	token_o.map = [startLine, state.line];
	const token_i = state.push("inline", "", 0);
	token_i.content = content;
	token_i.map = [startLine, state.line - 1];
	token_i.children = [];
	const token_c = state.push("heading_close", "h" + String(level), -1);
	token_c.markup = String.fromCharCode(marker);
	state.parentType = oldParentType;
	return true;
}
function paragraph(state, startLine, endLine) {
	const terminatorRules = state.md.block.ruler.getRules("paragraph");
	const oldParentType = state.parentType;
	let nextLine = startLine + 1;
	state.parentType = "paragraph";
	for (; nextLine < endLine && !state.isEmpty(nextLine); nextLine++) {
		if (state.sCount[nextLine] - state.blkIndent > 3) continue;
		if (state.sCount[nextLine] < 0) continue;
		let terminate = false;
		for (let i = 0, l = terminatorRules.length; i < l; i++) if (terminatorRules[i](state, nextLine, endLine, true)) {
			terminate = true;
			break;
		}
		if (terminate) break;
	}
	const content = state.getLines(startLine, nextLine, state.blkIndent, false).trim();
	state.line = nextLine;
	const token_o = state.push("paragraph_open", "p", 1);
	token_o.map = [startLine, state.line];
	const token_i = state.push("inline", "", 0);
	token_i.content = content;
	token_i.map = [startLine, state.line];
	token_i.children = [];
	state.push("paragraph_close", "p", -1);
	state.parentType = oldParentType;
	return true;
}
/** internal
* class ParserBlock
*
* Block-level tokenizer.
**/
const _rules$1 = [
	[
		"table",
		table,
		["paragraph", "reference"]
	],
	["code", code],
	[
		"fence",
		fence,
		[
			"paragraph",
			"reference",
			"blockquote",
			"list"
		]
	],
	[
		"blockquote",
		blockquote,
		[
			"paragraph",
			"reference",
			"blockquote",
			"list"
		]
	],
	[
		"hr",
		hr,
		[
			"paragraph",
			"reference",
			"blockquote",
			"list"
		]
	],
	[
		"list",
		list,
		[
			"paragraph",
			"reference",
			"blockquote"
		]
	],
	["reference", reference],
	[
		"html_block",
		html_block,
		[
			"paragraph",
			"reference",
			"blockquote"
		]
	],
	[
		"heading",
		heading,
		[
			"paragraph",
			"reference",
			"blockquote"
		]
	],
	["lheading", lheading],
	["paragraph", paragraph]
];
/**
* new ParserBlock()
**/
function ParserBlock() {
	/**
	* ParserBlock#ruler -> Ruler
	*
	* [[Ruler]] instance. Keep configuration of block rules.
	**/
	this.ruler = new Ruler();
	for (let i = 0; i < _rules$1.length; i++) this.ruler.push(_rules$1[i][0], _rules$1[i][1], { alt: (_rules$1[i][2] || []).slice() });
}
ParserBlock.prototype.tokenize = function(state, startLine, endLine) {
	const rules = this.ruler.getRules("");
	const len = rules.length;
	const maxNesting = state.md.options.maxNesting;
	let line = startLine;
	let hasEmptyLines = false;
	while (line < endLine) {
		state.line = line = state.skipEmptyLines(line);
		if (line >= endLine) break;
		if (state.sCount[line] < state.blkIndent) break;
		if (state.level >= maxNesting) {
			state.line = endLine;
			break;
		}
		const prevLine = state.line;
		let ok = false;
		for (let i = 0; i < len; i++) {
			ok = rules[i](state, line, endLine, false);
			if (ok) {
				if (prevLine >= state.line) throw new Error("block rule didn't increment state.line");
				break;
			}
		}
		if (!ok) throw new Error("none of the block rules matched");
		state.tight = !hasEmptyLines;
		if (state.isEmpty(state.line - 1)) hasEmptyLines = true;
		line = state.line;
		if (line < endLine && state.isEmpty(line)) {
			hasEmptyLines = true;
			line++;
			state.line = line;
		}
	}
};
/**
* ParserBlock.parse(str, md, env, outTokens)
*
* Process input string and push block tokens into `outTokens`
**/
ParserBlock.prototype.parse = function(src, md, env, outTokens) {
	if (!src) return;
	const state = new this.State(src, md, env, outTokens);
	this.tokenize(state, state.line, state.lineMax);
};
ParserBlock.prototype.State = StateBlock;
function StateInline(src, md, env, outTokens) {
	this.src = src;
	this.env = env;
	this.md = md;
	this.tokens = outTokens;
	this.tokens_meta = Array(outTokens.length);
	this.pos = 0;
	this.posMax = this.src.length;
	this.level = 0;
	this.pending = "";
	this.pendingLevel = 0;
	this.cache = {};
	this.delimiters = [];
	this._prev_delimiters = [];
	this.backticks = {};
	this.backticksScanned = false;
	this.linkLevel = 0;
}
StateInline.prototype.pushPending = function() {
	const token = new Token("text", "", 0);
	token.content = this.pending;
	token.level = this.pendingLevel;
	this.tokens.push(token);
	this.pending = "";
	return token;
};
StateInline.prototype.push = function(type, tag, nesting) {
	if (this.pending) this.pushPending();
	const token = new Token(type, tag, nesting);
	let token_meta = null;
	if (nesting < 0) {
		this.level--;
		this.delimiters = this._prev_delimiters.pop();
	}
	token.level = this.level;
	if (nesting > 0) {
		this.level++;
		this._prev_delimiters.push(this.delimiters);
		this.delimiters = [];
		token_meta = { delimiters: this.delimiters };
	}
	this.pendingLevel = this.level;
	this.tokens.push(token);
	this.tokens_meta.push(token_meta);
	return token;
};
StateInline.prototype.scanDelims = function(start, canSplitWord) {
	const max = this.posMax;
	const marker = this.src.charCodeAt(start);
	const lastChar = start > 0 ? this.src.charCodeAt(start - 1) : 32;
	let pos = start;
	while (pos < max && this.src.charCodeAt(pos) === marker) pos++;
	const count = pos - start;
	const nextChar = pos < max ? this.src.charCodeAt(pos) : 32;
	const isLastPunctChar = isMdAsciiPunct(lastChar) || isPunctChar(String.fromCharCode(lastChar));
	const isNextPunctChar = isMdAsciiPunct(nextChar) || isPunctChar(String.fromCharCode(nextChar));
	const isLastWhiteSpace = isWhiteSpace(lastChar);
	const isNextWhiteSpace = isWhiteSpace(nextChar);
	const left_flanking = !isNextWhiteSpace && (!isNextPunctChar || isLastWhiteSpace || isLastPunctChar);
	const right_flanking = !isLastWhiteSpace && (!isLastPunctChar || isNextWhiteSpace || isNextPunctChar);
	return {
		can_open: left_flanking && (canSplitWord || !right_flanking || isLastPunctChar),
		can_close: right_flanking && (canSplitWord || !left_flanking || isNextPunctChar),
		length: count
	};
};
StateInline.prototype.Token = Token;
function isTerminatorChar(ch) {
	switch (ch) {
		case 10:
		case 33:
		case 35:
		case 36:
		case 37:
		case 38:
		case 42:
		case 43:
		case 45:
		case 58:
		case 60:
		case 61:
		case 62:
		case 64:
		case 91:
		case 92:
		case 93:
		case 94:
		case 95:
		case 96:
		case 123:
		case 125:
		case 126: return true;
		default: return false;
	}
}
function text(state, silent) {
	let pos = state.pos;
	while (pos < state.posMax && !isTerminatorChar(state.src.charCodeAt(pos))) pos++;
	if (pos === state.pos) return false;
	if (!silent) state.pending += state.src.slice(state.pos, pos);
	state.pos = pos;
	return true;
}
const SCHEME_RE = /(?:^|[^a-z0-9.+-])([a-z][a-z0-9.+-]*)$/i;
function linkify(state, silent) {
	if (!state.md.options.linkify) return false;
	if (state.linkLevel > 0) return false;
	const pos = state.pos;
	const max = state.posMax;
	if (pos + 3 > max) return false;
	if (state.src.charCodeAt(pos) !== 58) return false;
	if (state.src.charCodeAt(pos + 1) !== 47) return false;
	if (state.src.charCodeAt(pos + 2) !== 47) return false;
	const match = state.pending.match(SCHEME_RE);
	if (!match) return false;
	const proto = match[1];
	const link = state.md.linkify.matchAtStart(state.src.slice(pos - proto.length));
	if (!link) return false;
	let url = link.url;
	if (url.length <= proto.length) return false;
	let urlEnd = url.length;
	while (urlEnd > 0 && url.charCodeAt(urlEnd - 1) === 42) urlEnd--;
	if (urlEnd !== url.length) url = url.slice(0, urlEnd);
	const fullUrl = state.md.normalizeLink(url);
	if (!state.md.validateLink(fullUrl)) return false;
	if (!silent) {
		state.pending = state.pending.slice(0, -proto.length);
		const token_o = state.push("link_open", "a", 1);
		token_o.attrs = [["href", fullUrl]];
		token_o.markup = "linkify";
		token_o.info = "auto";
		const token_t = state.push("text", "", 0);
		token_t.content = state.md.normalizeLinkText(url);
		const token_c = state.push("link_close", "a", -1);
		token_c.markup = "linkify";
		token_c.info = "auto";
	}
	state.pos += url.length - proto.length;
	return true;
}
function newline(state, silent) {
	let pos = state.pos;
	if (state.src.charCodeAt(pos) !== 10) return false;
	const pmax = state.pending.length - 1;
	const max = state.posMax;
	if (!silent) if (pmax >= 0 && state.pending.charCodeAt(pmax) === 32) if (pmax >= 1 && state.pending.charCodeAt(pmax - 1) === 32) {
		let ws = pmax - 1;
		while (ws >= 1 && state.pending.charCodeAt(ws - 1) === 32) ws--;
		state.pending = state.pending.slice(0, ws);
		state.push("hardbreak", "br", 0);
	} else {
		state.pending = state.pending.slice(0, -1);
		state.push("softbreak", "br", 0);
	}
	else state.push("softbreak", "br", 0);
	pos++;
	while (pos < max && isSpace(state.src.charCodeAt(pos))) pos++;
	state.pos = pos;
	return true;
}
const ESCAPED = [];
for (let i = 0; i < 256; i++) ESCAPED.push(0);
"\\!\"#$%&'()*+,./:;<=>?@[]^_`{|}~-".split("").forEach(function(ch) {
	ESCAPED[ch.charCodeAt(0)] = 1;
});
function escape(state, silent) {
	let pos = state.pos;
	const max = state.posMax;
	if (state.src.charCodeAt(pos) !== 92) return false;
	pos++;
	if (pos >= max) return false;
	let ch1 = state.src.charCodeAt(pos);
	if (ch1 === 10) {
		if (!silent) state.push("hardbreak", "br", 0);
		pos++;
		while (pos < max) {
			ch1 = state.src.charCodeAt(pos);
			if (!isSpace(ch1)) break;
			pos++;
		}
		state.pos = pos;
		return true;
	}
	let escapedStr = state.src[pos];
	if (ch1 >= 55296 && ch1 <= 56319 && pos + 1 < max) {
		const ch2 = state.src.charCodeAt(pos + 1);
		if (ch2 >= 56320 && ch2 <= 57343) {
			escapedStr += state.src[pos + 1];
			pos++;
		}
	}
	const origStr = "\\" + escapedStr;
	if (!silent) {
		const token = state.push("text_special", "", 0);
		if (ch1 < 256 && ESCAPED[ch1] !== 0) token.content = escapedStr;
		else token.content = origStr;
		token.markup = origStr;
		token.info = "escape";
	}
	state.pos = pos + 1;
	return true;
}
function backtick(state, silent) {
	let pos = state.pos;
	if (state.src.charCodeAt(pos) !== 96) return false;
	const start = pos;
	pos++;
	const max = state.posMax;
	while (pos < max && state.src.charCodeAt(pos) === 96) pos++;
	const marker = state.src.slice(start, pos);
	const openerLength = marker.length;
	if (state.backticksScanned && (state.backticks[openerLength] || 0) <= start) {
		if (!silent) state.pending += marker;
		state.pos += openerLength;
		return true;
	}
	let matchEnd = pos;
	let matchStart;
	while ((matchStart = state.src.indexOf("`", matchEnd)) !== -1) {
		matchEnd = matchStart + 1;
		while (matchEnd < max && state.src.charCodeAt(matchEnd) === 96) matchEnd++;
		const closerLength = matchEnd - matchStart;
		if (closerLength === openerLength) {
			if (!silent) {
				const token = state.push("code_inline", "code", 0);
				token.markup = marker;
				token.content = state.src.slice(pos, matchStart).replace(/\n/g, " ").replace(/^ (.+) $/, "$1");
			}
			state.pos = matchEnd;
			return true;
		}
		state.backticks[closerLength] = matchStart;
	}
	state.backticksScanned = true;
	if (!silent) state.pending += marker;
	state.pos += openerLength;
	return true;
}
function strikethrough_tokenize(state, silent) {
	const start = state.pos;
	const marker = state.src.charCodeAt(start);
	if (silent) return false;
	if (marker !== 126) return false;
	const scanned = state.scanDelims(state.pos, true);
	let len = scanned.length;
	const ch = String.fromCharCode(marker);
	if (len < 2) return false;
	let token;
	if (len % 2) {
		token = state.push("text", "", 0);
		token.content = ch;
		len--;
	}
	for (let i = 0; i < len; i += 2) {
		token = state.push("text", "", 0);
		token.content = ch + ch;
		state.delimiters.push({
			marker,
			length: 0,
			token: state.tokens.length - 1,
			end: -1,
			open: scanned.can_open,
			close: scanned.can_close
		});
	}
	state.pos += scanned.length;
	return true;
}
function postProcess$1(state, delimiters) {
	let token;
	const loneMarkers = [];
	const max = delimiters.length;
	for (let i = 0; i < max; i++) {
		const startDelim = delimiters[i];
		if (startDelim.marker !== 126) continue;
		if (startDelim.end === -1) continue;
		const endDelim = delimiters[startDelim.end];
		token = state.tokens[startDelim.token];
		token.type = "s_open";
		token.tag = "s";
		token.nesting = 1;
		token.markup = "~~";
		token.content = "";
		token = state.tokens[endDelim.token];
		token.type = "s_close";
		token.tag = "s";
		token.nesting = -1;
		token.markup = "~~";
		token.content = "";
		if (state.tokens[endDelim.token - 1].type === "text" && state.tokens[endDelim.token - 1].content === "~") loneMarkers.push(endDelim.token - 1);
	}
	while (loneMarkers.length) {
		const i = loneMarkers.pop();
		let j = i + 1;
		while (j < state.tokens.length && state.tokens[j].type === "s_close") j++;
		j--;
		if (i !== j) {
			token = state.tokens[j];
			state.tokens[j] = state.tokens[i];
			state.tokens[i] = token;
		}
	}
}
function strikethrough_postProcess(state) {
	const tokens_meta = state.tokens_meta;
	const max = state.tokens_meta.length;
	postProcess$1(state, state.delimiters);
	for (let curr = 0; curr < max; curr++) if (tokens_meta[curr] && tokens_meta[curr].delimiters) postProcess$1(state, tokens_meta[curr].delimiters);
}
var strikethrough_default = {
	tokenize: strikethrough_tokenize,
	postProcess: strikethrough_postProcess
};
function emphasis_tokenize(state, silent) {
	const start = state.pos;
	const marker = state.src.charCodeAt(start);
	if (silent) return false;
	if (marker !== 95 && marker !== 42) return false;
	const scanned = state.scanDelims(state.pos, marker === 42);
	for (let i = 0; i < scanned.length; i++) {
		const token = state.push("text", "", 0);
		token.content = String.fromCharCode(marker);
		state.delimiters.push({
			marker,
			length: scanned.length,
			token: state.tokens.length - 1,
			end: -1,
			open: scanned.can_open,
			close: scanned.can_close
		});
	}
	state.pos += scanned.length;
	return true;
}
function postProcess(state, delimiters) {
	const max = delimiters.length;
	for (let i = max - 1; i >= 0; i--) {
		const startDelim = delimiters[i];
		if (startDelim.marker !== 95 && startDelim.marker !== 42) continue;
		if (startDelim.end === -1) continue;
		const endDelim = delimiters[startDelim.end];
		const isStrong = i > 0 && delimiters[i - 1].end === startDelim.end + 1 && delimiters[i - 1].marker === startDelim.marker && delimiters[i - 1].token === startDelim.token - 1 && delimiters[startDelim.end + 1].token === endDelim.token + 1;
		const ch = String.fromCharCode(startDelim.marker);
		const token_o = state.tokens[startDelim.token];
		token_o.type = isStrong ? "strong_open" : "em_open";
		token_o.tag = isStrong ? "strong" : "em";
		token_o.nesting = 1;
		token_o.markup = isStrong ? ch + ch : ch;
		token_o.content = "";
		const token_c = state.tokens[endDelim.token];
		token_c.type = isStrong ? "strong_close" : "em_close";
		token_c.tag = isStrong ? "strong" : "em";
		token_c.nesting = -1;
		token_c.markup = isStrong ? ch + ch : ch;
		token_c.content = "";
		if (isStrong) {
			state.tokens[delimiters[i - 1].token].content = "";
			state.tokens[delimiters[startDelim.end + 1].token].content = "";
			i--;
		}
	}
}
function emphasis_post_process(state) {
	const tokens_meta = state.tokens_meta;
	const max = state.tokens_meta.length;
	postProcess(state, state.delimiters);
	for (let curr = 0; curr < max; curr++) if (tokens_meta[curr] && tokens_meta[curr].delimiters) postProcess(state, tokens_meta[curr].delimiters);
}
var emphasis_default = {
	tokenize: emphasis_tokenize,
	postProcess: emphasis_post_process
};
function link(state, silent) {
	let code, label, res, ref;
	let href = "";
	let title = "";
	let start = state.pos;
	let parseReference = true;
	if (state.src.charCodeAt(state.pos) !== 91) return false;
	const oldPos = state.pos;
	const max = state.posMax;
	const labelStart = state.pos + 1;
	const labelEnd = state.md.helpers.parseLinkLabel(state, state.pos, true);
	if (labelEnd < 0) return false;
	let pos = labelEnd + 1;
	if (pos < max && state.src.charCodeAt(pos) === 40) {
		parseReference = false;
		pos++;
		for (; pos < max; pos++) {
			code = state.src.charCodeAt(pos);
			if (!isSpace(code) && code !== 10) break;
		}
		if (pos >= max) return false;
		start = pos;
		res = state.md.helpers.parseLinkDestination(state.src, pos, state.posMax);
		if (res.ok) {
			href = state.md.normalizeLink(res.str);
			if (state.md.validateLink(href)) pos = res.pos;
			else href = "";
			start = pos;
			for (; pos < max; pos++) {
				code = state.src.charCodeAt(pos);
				if (!isSpace(code) && code !== 10) break;
			}
			res = state.md.helpers.parseLinkTitle(state.src, pos, state.posMax);
			if (pos < max && start !== pos && res.ok) {
				title = res.str;
				pos = res.pos;
				for (; pos < max; pos++) {
					code = state.src.charCodeAt(pos);
					if (!isSpace(code) && code !== 10) break;
				}
			}
		}
		if (pos >= max || state.src.charCodeAt(pos) !== 41) parseReference = true;
		pos++;
	}
	if (parseReference) {
		if (typeof state.env.references === "undefined") return false;
		if (pos < max && state.src.charCodeAt(pos) === 91) {
			start = pos + 1;
			pos = state.md.helpers.parseLinkLabel(state, pos);
			if (pos >= 0) label = state.src.slice(start, pos++);
			else pos = labelEnd + 1;
		} else pos = labelEnd + 1;
		if (!label) label = state.src.slice(labelStart, labelEnd);
		ref = state.env.references[normalizeReference(label)];
		if (!ref) {
			state.pos = oldPos;
			return false;
		}
		href = ref.href;
		title = ref.title;
	}
	if (!silent) {
		state.pos = labelStart;
		state.posMax = labelEnd;
		const token_o = state.push("link_open", "a", 1);
		const attrs = [["href", href]];
		token_o.attrs = attrs;
		if (title) attrs.push(["title", title]);
		state.linkLevel++;
		state.md.inline.tokenize(state);
		state.linkLevel--;
		state.push("link_close", "a", -1);
	}
	state.pos = pos;
	state.posMax = max;
	return true;
}
function image(state, silent) {
	let code, content, label, pos, ref, res, title, start;
	let href = "";
	const oldPos = state.pos;
	const max = state.posMax;
	if (state.src.charCodeAt(state.pos) !== 33) return false;
	if (state.src.charCodeAt(state.pos + 1) !== 91) return false;
	const labelStart = state.pos + 2;
	const labelEnd = state.md.helpers.parseLinkLabel(state, state.pos + 1, false);
	if (labelEnd < 0) return false;
	pos = labelEnd + 1;
	if (pos < max && state.src.charCodeAt(pos) === 40) {
		pos++;
		for (; pos < max; pos++) {
			code = state.src.charCodeAt(pos);
			if (!isSpace(code) && code !== 10) break;
		}
		if (pos >= max) return false;
		start = pos;
		res = state.md.helpers.parseLinkDestination(state.src, pos, state.posMax);
		if (res.ok) {
			href = state.md.normalizeLink(res.str);
			if (state.md.validateLink(href)) pos = res.pos;
			else href = "";
		}
		start = pos;
		for (; pos < max; pos++) {
			code = state.src.charCodeAt(pos);
			if (!isSpace(code) && code !== 10) break;
		}
		res = state.md.helpers.parseLinkTitle(state.src, pos, state.posMax);
		if (pos < max && start !== pos && res.ok) {
			title = res.str;
			pos = res.pos;
			for (; pos < max; pos++) {
				code = state.src.charCodeAt(pos);
				if (!isSpace(code) && code !== 10) break;
			}
		} else title = "";
		if (pos >= max || state.src.charCodeAt(pos) !== 41) {
			state.pos = oldPos;
			return false;
		}
		pos++;
	} else {
		if (typeof state.env.references === "undefined") return false;
		if (pos < max && state.src.charCodeAt(pos) === 91) {
			start = pos + 1;
			pos = state.md.helpers.parseLinkLabel(state, pos);
			if (pos >= 0) label = state.src.slice(start, pos++);
			else pos = labelEnd + 1;
		} else pos = labelEnd + 1;
		if (!label) label = state.src.slice(labelStart, labelEnd);
		ref = state.env.references[normalizeReference(label)];
		if (!ref) {
			state.pos = oldPos;
			return false;
		}
		href = ref.href;
		title = ref.title;
	}
	if (!silent) {
		content = state.src.slice(labelStart, labelEnd);
		const tokens = [];
		state.md.inline.parse(content, state.md, state.env, tokens);
		const token = state.push("image", "img", 0);
		const attrs = [["src", href], ["alt", ""]];
		token.attrs = attrs;
		token.children = tokens;
		token.content = content;
		if (title) attrs.push(["title", title]);
	}
	state.pos = pos;
	state.posMax = max;
	return true;
}
const EMAIL_RE = /^([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)$/;
const AUTOLINK_RE = /^([a-zA-Z][a-zA-Z0-9+.-]{1,31}):([^<>\x00-\x20]*)$/;
function autolink(state, silent) {
	let pos = state.pos;
	if (state.src.charCodeAt(pos) !== 60) return false;
	const start = state.pos;
	const max = state.posMax;
	for (;;) {
		if (++pos >= max) return false;
		const ch = state.src.charCodeAt(pos);
		if (ch === 60) return false;
		if (ch === 62) break;
	}
	const url = state.src.slice(start + 1, pos);
	if (AUTOLINK_RE.test(url)) {
		const fullUrl = state.md.normalizeLink(url);
		if (!state.md.validateLink(fullUrl)) return false;
		if (!silent) {
			const token_o = state.push("link_open", "a", 1);
			token_o.attrs = [["href", fullUrl]];
			token_o.markup = "autolink";
			token_o.info = "auto";
			const token_t = state.push("text", "", 0);
			token_t.content = state.md.normalizeLinkText(url);
			const token_c = state.push("link_close", "a", -1);
			token_c.markup = "autolink";
			token_c.info = "auto";
		}
		state.pos += url.length + 2;
		return true;
	}
	if (EMAIL_RE.test(url)) {
		const fullUrl = state.md.normalizeLink("mailto:" + url);
		if (!state.md.validateLink(fullUrl)) return false;
		if (!silent) {
			const token_o = state.push("link_open", "a", 1);
			token_o.attrs = [["href", fullUrl]];
			token_o.markup = "autolink";
			token_o.info = "auto";
			const token_t = state.push("text", "", 0);
			token_t.content = state.md.normalizeLinkText(url);
			const token_c = state.push("link_close", "a", -1);
			token_c.markup = "autolink";
			token_c.info = "auto";
		}
		state.pos += url.length + 2;
		return true;
	}
	return false;
}
function isLinkOpen(str) {
	return /^<a[>\s]/i.test(str);
}
function isLinkClose(str) {
	return /^<\/a\s*>/i.test(str);
}
function isLetter(ch) {
	const lc = ch | 32;
	return lc >= 97 && lc <= 122;
}
function html_inline(state, silent) {
	if (!state.md.options.html) return false;
	const max = state.posMax;
	const pos = state.pos;
	if (state.src.charCodeAt(pos) !== 60 || pos + 2 >= max) return false;
	const ch = state.src.charCodeAt(pos + 1);
	if (ch !== 33 && ch !== 63 && ch !== 47 && !isLetter(ch)) return false;
	const match = state.src.slice(pos).match(HTML_TAG_RE);
	if (!match) return false;
	if (!silent) {
		const token = state.push("html_inline", "", 0);
		token.content = match[0];
		if (isLinkOpen(token.content)) state.linkLevel++;
		if (isLinkClose(token.content)) state.linkLevel--;
	}
	state.pos += match[0].length;
	return true;
}
const DIGITAL_RE = /^&#((?:x[a-f0-9]{1,6}|[0-9]{1,7}));/i;
const NAMED_RE = /^&([a-z][a-z0-9]{1,31});/i;
function entity(state, silent) {
	const pos = state.pos;
	const max = state.posMax;
	if (state.src.charCodeAt(pos) !== 38) return false;
	if (pos + 1 >= max) return false;
	if (state.src.charCodeAt(pos + 1) === 35) {
		const match = state.src.slice(pos).match(DIGITAL_RE);
		if (match) {
			if (!silent) {
				const code = match[1][0].toLowerCase() === "x" ? parseInt(match[1].slice(1), 16) : parseInt(match[1], 10);
				const token = state.push("text_special", "", 0);
				token.content = isValidEntityCode(code) ? fromCodePoint(code) : fromCodePoint(65533);
				token.markup = match[0];
				token.info = "entity";
			}
			state.pos += match[0].length;
			return true;
		}
	} else {
		const match = state.src.slice(pos).match(NAMED_RE);
		if (match) {
			const decoded = decodeHTML(match[0]);
			if (decoded !== match[0]) {
				if (!silent) {
					const token = state.push("text_special", "", 0);
					token.content = decoded;
					token.markup = match[0];
					token.info = "entity";
				}
				state.pos += match[0].length;
				return true;
			}
		}
	}
	return false;
}
function processDelimiters(delimiters) {
	const openersBottom = {};
	const max = delimiters.length;
	if (!max) return;
	let headerIdx = 0;
	let lastTokenIdx = -2;
	const jumps = [];
	for (let closerIdx = 0; closerIdx < max; closerIdx++) {
		const closer = delimiters[closerIdx];
		jumps.push(0);
		if (delimiters[headerIdx].marker !== closer.marker || lastTokenIdx !== closer.token - 1) headerIdx = closerIdx;
		lastTokenIdx = closer.token;
		closer.length = closer.length || 0;
		if (!closer.close) continue;
		if (!openersBottom.hasOwnProperty(closer.marker)) openersBottom[closer.marker] = [
			-1,
			-1,
			-1,
			-1,
			-1,
			-1
		];
		const minOpenerIdx = openersBottom[closer.marker][(closer.open ? 3 : 0) + closer.length % 3];
		let openerIdx = headerIdx - jumps[headerIdx] - 1;
		let newMinOpenerIdx = openerIdx;
		for (; openerIdx > minOpenerIdx; openerIdx -= jumps[openerIdx] + 1) {
			const opener = delimiters[openerIdx];
			if (opener.marker !== closer.marker) continue;
			if (opener.open && opener.end < 0) {
				let isOddMatch = false;
				if (opener.close || closer.open) {
					if ((opener.length + closer.length) % 3 === 0) {
						if (opener.length % 3 !== 0 || closer.length % 3 !== 0) isOddMatch = true;
					}
				}
				if (!isOddMatch) {
					const lastJump = openerIdx > 0 && !delimiters[openerIdx - 1].open ? jumps[openerIdx - 1] + 1 : 0;
					jumps[closerIdx] = closerIdx - openerIdx + lastJump;
					jumps[openerIdx] = lastJump;
					closer.open = false;
					opener.end = closerIdx;
					opener.close = false;
					newMinOpenerIdx = -1;
					lastTokenIdx = -2;
					break;
				}
			}
		}
		if (newMinOpenerIdx !== -1) openersBottom[closer.marker][(closer.open ? 3 : 0) + (closer.length || 0) % 3] = newMinOpenerIdx;
	}
}
function link_pairs(state) {
	const tokens_meta = state.tokens_meta;
	const max = state.tokens_meta.length;
	processDelimiters(state.delimiters);
	for (let curr = 0; curr < max; curr++) if (tokens_meta[curr] && tokens_meta[curr].delimiters) processDelimiters(tokens_meta[curr].delimiters);
}
function fragments_join(state) {
	let curr, last;
	let level = 0;
	const tokens = state.tokens;
	const max = state.tokens.length;
	for (curr = last = 0; curr < max; curr++) {
		if (tokens[curr].nesting < 0) level--;
		tokens[curr].level = level;
		if (tokens[curr].nesting > 0) level++;
		if (tokens[curr].type === "text" && curr + 1 < max && tokens[curr + 1].type === "text") tokens[curr + 1].content = tokens[curr].content + tokens[curr + 1].content;
		else {
			if (curr !== last) tokens[last] = tokens[curr];
			last++;
		}
	}
	if (curr !== last) tokens.length = last;
}
/** internal
* class ParserInline
*
* Tokenizes paragraph content.
**/
const _rules = [
	["text", text],
	["linkify", linkify],
	["newline", newline],
	["escape", escape],
	["backticks", backtick],
	["strikethrough", strikethrough_default.tokenize],
	["emphasis", emphasis_default.tokenize],
	["link", link],
	["image", image],
	["autolink", autolink],
	["html_inline", html_inline],
	["entity", entity]
];
const _rules2 = [
	["balance_pairs", link_pairs],
	["strikethrough", strikethrough_default.postProcess],
	["emphasis", emphasis_default.postProcess],
	["fragments_join", fragments_join]
];
/**
* new ParserInline()
**/
function ParserInline() {
	/**
	* ParserInline#ruler -> Ruler
	*
	* [[Ruler]] instance. Keep configuration of inline rules.
	**/
	this.ruler = new Ruler();
	for (let i = 0; i < _rules.length; i++) this.ruler.push(_rules[i][0], _rules[i][1]);
	/**
	* ParserInline#ruler2 -> Ruler
	*
	* [[Ruler]] instance. Second ruler used for post-processing
	* (e.g. in emphasis-like rules).
	**/
	this.ruler2 = new Ruler();
	for (let i = 0; i < _rules2.length; i++) this.ruler2.push(_rules2[i][0], _rules2[i][1]);
}
ParserInline.prototype.skipToken = function(state) {
	const pos = state.pos;
	const rules = this.ruler.getRules("");
	const len = rules.length;
	const maxNesting = state.md.options.maxNesting;
	const cache = state.cache;
	if (typeof cache[pos] !== "undefined") {
		state.pos = cache[pos];
		return;
	}
	let ok = false;
	if (state.level < maxNesting) for (let i = 0; i < len; i++) {
		state.level++;
		ok = rules[i](state, true);
		state.level--;
		if (ok) {
			if (pos >= state.pos) throw new Error("inline rule didn't increment state.pos");
			break;
		}
	}
	else state.pos = state.posMax;
	if (!ok) state.pos++;
	cache[pos] = state.pos;
};
ParserInline.prototype.tokenize = function(state) {
	const rules = this.ruler.getRules("");
	const len = rules.length;
	const end = state.posMax;
	const maxNesting = state.md.options.maxNesting;
	while (state.pos < end) {
		const prevPos = state.pos;
		let ok = false;
		if (state.level < maxNesting) for (let i = 0; i < len; i++) {
			ok = rules[i](state, false);
			if (ok) {
				if (prevPos >= state.pos) throw new Error("inline rule didn't increment state.pos");
				break;
			}
		}
		if (ok) {
			if (state.pos >= end) break;
			continue;
		}
		state.pending += state.src[state.pos++];
	}
	if (state.pending) state.pushPending();
};
/**
* ParserInline.parse(str, md, env, outTokens)
*
* Process input string and push inline tokens into `outTokens`
**/
ParserInline.prototype.parse = function(str, md, env, outTokens) {
	const state = new this.State(str, md, env, outTokens);
	this.tokenize(state);
	const rules = this.ruler2.getRules("");
	const len = rules.length;
	for (let i = 0; i < len; i++) rules[i](state);
};
ParserInline.prototype.State = StateInline;
function re_default(opts) {
	const re = {};
	opts = opts || {};
	re.src_Any = regex_default$5.source;
	re.src_Cc = regex_default$4.source;
	re.src_Z = regex_default.source;
	re.src_P = regex_default$2.source;
	re.src_ZPCc = [
		re.src_Z,
		re.src_P,
		re.src_Cc
	].join("|");
	re.src_ZCc = [re.src_Z, re.src_Cc].join("|");
	const text_separators = "[><｜]";
	re.src_pseudo_letter = "(?:(?!" + text_separators + "|" + re.src_ZPCc + ")" + re.src_Any + ")";
	re.src_ip4 = "(?:(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)";
	re.src_auth = "(?:(?:(?!" + re.src_ZCc + "|[@/\\[\\]()]).)+@)?";
	re.src_port = "(?::(?:6(?:[0-4]\\d{3}|5(?:[0-4]\\d{2}|5(?:[0-2]\\d|3[0-5])))|[1-5]?\\d{1,4}))?";
	re.src_host_terminator = "(?=$|" + text_separators + "|" + re.src_ZPCc + ")(?!" + (opts["---"] ? "-(?!--)|" : "-|") + "_|:\\d|\\.-|\\.(?!$|" + re.src_ZPCc + "))";
	re.src_path = "(?:[/?#](?:(?!" + re.src_ZCc + "|[><｜]|[()[\\]{}.,\"'?!\\-;]).|\\[(?:(?!" + re.src_ZCc + "|\\]).)*\\]|\\((?:(?!" + re.src_ZCc + "|[)]).)*\\)|\\{(?:(?!" + re.src_ZCc + "|[}]).)*\\}|\\\"(?:(?!" + re.src_ZCc + "|[\"]).)+\\\"|\\'(?:(?!" + re.src_ZCc + "|[']).)+\\'|\\'(?=" + re.src_pseudo_letter + "|[-])|\\.{2,}[a-zA-Z0-9%/&]|\\.(?!" + re.src_ZCc + "|[.]|$)|" + (opts["---"] ? "\\-(?!--(?:[^-]|$))(?:-*)|" : "\\-+|") + ",(?!" + re.src_ZCc + "|$)|;(?!" + re.src_ZCc + "|$)|\\!+(?!" + re.src_ZCc + "|[!]|$)|\\?(?!" + re.src_ZCc + "|[?]|$))+|\\/)?";
	re.src_email_name = "[\\-;:&=\\+\\$,\\.a-zA-Z0-9_][\\-;:&=\\+\\$,\\\"\\.a-zA-Z0-9_]*";
	re.src_xn = "xn--[a-z0-9\\-]{1,59}";
	re.src_domain_root = "(?:" + re.src_xn + "|" + re.src_pseudo_letter + "{1,63})";
	re.src_domain = "(?:" + re.src_xn + "|(?:" + re.src_pseudo_letter + ")|(?:" + re.src_pseudo_letter + "(?:-|" + re.src_pseudo_letter + "){0,61}" + re.src_pseudo_letter + "))";
	re.src_host = "(?:(?:(?:(?:" + re.src_domain + ")\\.)*" + re.src_domain + "))";
	re.tpl_host_fuzzy = "(?:" + re.src_ip4 + "|(?:(?:(?:" + re.src_domain + ")\\.)+(?:%TLDS%)))";
	re.tpl_host_no_ip_fuzzy = "(?:(?:(?:" + re.src_domain + ")\\.)+(?:%TLDS%))";
	re.src_host_strict = re.src_host + re.src_host_terminator;
	re.tpl_host_fuzzy_strict = re.tpl_host_fuzzy + re.src_host_terminator;
	re.src_host_port_strict = re.src_host + re.src_port + re.src_host_terminator;
	re.tpl_host_port_fuzzy_strict = re.tpl_host_fuzzy + re.src_port + re.src_host_terminator;
	re.tpl_host_port_no_ip_fuzzy_strict = re.tpl_host_no_ip_fuzzy + re.src_port + re.src_host_terminator;
	re.tpl_host_fuzzy_test = "localhost|www\\.|\\.\\d{1,3}\\.|(?:\\.(?:%TLDS%)(?:" + re.src_ZPCc + "|>|$))";
	re.tpl_email_fuzzy = "(^|" + text_separators + "|\"|\\(|" + re.src_ZCc + ")(" + re.src_email_name + "@" + re.tpl_host_fuzzy_strict + ")";
	re.tpl_link_fuzzy = "(^|(?![.:/\\-_@])(?:[$+<=>^`|｜]|" + re.src_ZPCc + "))((?![$+<=>^`|｜])" + re.tpl_host_port_fuzzy_strict + re.src_path + ")";
	re.tpl_link_no_ip_fuzzy = "(^|(?![.:/\\-_@])(?:[$+<=>^`|｜]|" + re.src_ZPCc + "))((?![$+<=>^`|｜])" + re.tpl_host_port_no_ip_fuzzy_strict + re.src_path + ")";
	return re;
}
function assign(obj) {
	Array.prototype.slice.call(arguments, 1).forEach(function(source) {
		if (!source) return;
		Object.keys(source).forEach(function(key) {
			obj[key] = source[key];
		});
	});
	return obj;
}
function _class(obj) {
	return Object.prototype.toString.call(obj);
}
function isString(obj) {
	return _class(obj) === "[object String]";
}
function isObject(obj) {
	return _class(obj) === "[object Object]";
}
function isRegExp(obj) {
	return _class(obj) === "[object RegExp]";
}
function isFunction(obj) {
	return _class(obj) === "[object Function]";
}
function escapeRE(str) {
	return str.replace(/[.?*+^$[\]\\(){}|-]/g, "\\$&");
}
const defaultOptions = {
	fuzzyLink: true,
	fuzzyEmail: true,
	fuzzyIP: false
};
function isOptionsObj(obj) {
	return Object.keys(obj || {}).reduce(function(acc, k) {
		return acc || defaultOptions.hasOwnProperty(k);
	}, false);
}
const defaultSchemas = {
	"http:": { validate: function(text, pos, self) {
		const tail = text.slice(pos);
		if (!self.re.http) self.re.http = new RegExp("^\\/\\/" + self.re.src_auth + self.re.src_host_port_strict + self.re.src_path, "i");
		if (self.re.http.test(tail)) return tail.match(self.re.http)[0].length;
		return 0;
	} },
	"https:": "http:",
	"ftp:": "http:",
	"//": { validate: function(text, pos, self) {
		const tail = text.slice(pos);
		if (!self.re.no_http) self.re.no_http = new RegExp("^" + self.re.src_auth + "(?:localhost|(?:(?:" + self.re.src_domain + ")\\.)+" + self.re.src_domain_root + ")" + self.re.src_port + self.re.src_host_terminator + self.re.src_path, "i");
		if (self.re.no_http.test(tail)) {
			if (pos >= 3 && text[pos - 3] === ":") return 0;
			if (pos >= 3 && text[pos - 3] === "/") return 0;
			return tail.match(self.re.no_http)[0].length;
		}
		return 0;
	} },
	"mailto:": { validate: function(text, pos, self) {
		const tail = text.slice(pos);
		if (!self.re.mailto) self.re.mailto = new RegExp("^" + self.re.src_email_name + "@" + self.re.src_host_strict, "i");
		if (self.re.mailto.test(tail)) return tail.match(self.re.mailto)[0].length;
		return 0;
	} }
};
const tlds_2ch_src_re = "a[cdefgilmnoqrstuwxz]|b[abdefghijmnorstvwyz]|c[acdfghiklmnoruvwxyz]|d[ejkmoz]|e[cegrstu]|f[ijkmor]|g[abdefghilmnpqrstuwy]|h[kmnrtu]|i[delmnoqrst]|j[emop]|k[eghimnprwyz]|l[abcikrstuvy]|m[acdeghklmnopqrstuvwxyz]|n[acefgilopruz]|om|p[aefghklmnrstwy]|qa|r[eosuw]|s[abcdeghijklmnortuvxyz]|t[cdfghjklmnortvwz]|u[agksyz]|v[aceginu]|w[fs]|y[et]|z[amw]";
const tlds_default = "biz|com|edu|gov|net|org|pro|web|xxx|aero|asia|coop|info|museum|name|shop|рф".split("|");
function resetScanCache(self) {
	self.__index__ = -1;
	self.__text_cache__ = "";
}
function createValidator(re) {
	return function(text, pos) {
		const tail = text.slice(pos);
		if (re.test(tail)) return tail.match(re)[0].length;
		return 0;
	};
}
function createNormalizer() {
	return function(match, self) {
		self.normalize(match);
	};
}
function compile(self) {
	const re = self.re = re_default(self.__opts__);
	const tlds = self.__tlds__.slice();
	self.onCompile();
	if (!self.__tlds_replaced__) tlds.push(tlds_2ch_src_re);
	tlds.push(re.src_xn);
	re.src_tlds = tlds.join("|");
	function untpl(tpl) {
		return tpl.replace("%TLDS%", re.src_tlds);
	}
	re.email_fuzzy = RegExp(untpl(re.tpl_email_fuzzy), "i");
	re.link_fuzzy = RegExp(untpl(re.tpl_link_fuzzy), "i");
	re.link_no_ip_fuzzy = RegExp(untpl(re.tpl_link_no_ip_fuzzy), "i");
	re.host_fuzzy_test = RegExp(untpl(re.tpl_host_fuzzy_test), "i");
	const aliases = [];
	self.__compiled__ = {};
	function schemaError(name, val) {
		throw new Error("(LinkifyIt) Invalid schema \"" + name + "\": " + val);
	}
	Object.keys(self.__schemas__).forEach(function(name) {
		const val = self.__schemas__[name];
		if (val === null) return;
		const compiled = {
			validate: null,
			link: null
		};
		self.__compiled__[name] = compiled;
		if (isObject(val)) {
			if (isRegExp(val.validate)) compiled.validate = createValidator(val.validate);
			else if (isFunction(val.validate)) compiled.validate = val.validate;
			else schemaError(name, val);
			if (isFunction(val.normalize)) compiled.normalize = val.normalize;
			else if (!val.normalize) compiled.normalize = createNormalizer();
			else schemaError(name, val);
			return;
		}
		if (isString(val)) {
			aliases.push(name);
			return;
		}
		schemaError(name, val);
	});
	aliases.forEach(function(alias) {
		if (!self.__compiled__[self.__schemas__[alias]]) return;
		self.__compiled__[alias].validate = self.__compiled__[self.__schemas__[alias]].validate;
		self.__compiled__[alias].normalize = self.__compiled__[self.__schemas__[alias]].normalize;
	});
	self.__compiled__[""] = {
		validate: null,
		normalize: createNormalizer()
	};
	const slist = Object.keys(self.__compiled__).filter(function(name) {
		return name.length > 0 && self.__compiled__[name];
	}).map(escapeRE).join("|");
	self.re.schema_test = RegExp("(^|(?!_)(?:[><｜]|" + re.src_ZPCc + "))(" + slist + ")", "i");
	self.re.schema_search = RegExp("(^|(?!_)(?:[><｜]|" + re.src_ZPCc + "))(" + slist + ")", "ig");
	self.re.schema_at_start = RegExp("^" + self.re.schema_search.source, "i");
	self.re.pretest = RegExp("(" + self.re.schema_test.source + ")|(" + self.re.host_fuzzy_test.source + ")|@", "i");
	resetScanCache(self);
}
/**
* class Match
*
* Match result. Single element of array, returned by [[LinkifyIt#match]]
**/
function Match(self, shift) {
	const start = self.__index__;
	const end = self.__last_index__;
	const text = self.__text_cache__.slice(start, end);
	/**
	* Match#schema -> String
	*
	* Prefix (protocol) for matched string.
	**/
	this.schema = self.__schema__.toLowerCase();
	/**
	* Match#index -> Number
	*
	* First position of matched string.
	**/
	this.index = start + shift;
	/**
	* Match#lastIndex -> Number
	*
	* Next position after matched string.
	**/
	this.lastIndex = end + shift;
	/**
	* Match#raw -> String
	*
	* Matched string.
	**/
	this.raw = text;
	/**
	* Match#text -> String
	*
	* Notmalized text of matched string.
	**/
	this.text = text;
	/**
	* Match#url -> String
	*
	* Normalized url of matched string.
	**/
	this.url = text;
}
function createMatch(self, shift) {
	const match = new Match(self, shift);
	self.__compiled__[match.schema].normalize(match, self);
	return match;
}
/**
* class LinkifyIt
**/
/**
* new LinkifyIt(schemas, options)
* - schemas (Object): Optional. Additional schemas to validate (prefix/validator)
* - options (Object): { fuzzyLink|fuzzyEmail|fuzzyIP: true|false }
*
* Creates new linkifier instance with optional additional schemas.
* Can be called without `new` keyword for convenience.
*
* By default understands:
*
* - `http(s)://...` , `ftp://...`, `mailto:...` & `//...` links
* - "fuzzy" links and emails (example.com, foo@bar.com).
*
* `schemas` is an object, where each key/value describes protocol/rule:
*
* - __key__ - link prefix (usually, protocol name with `:` at the end, `skype:`
*   for example). `linkify-it` makes shure that prefix is not preceeded with
*   alphanumeric char and symbols. Only whitespaces and punctuation allowed.
* - __value__ - rule to check tail after link prefix
*   - _String_ - just alias to existing rule
*   - _Object_
*     - _validate_ - validator function (should return matched length on success),
*       or `RegExp`.
*     - _normalize_ - optional function to normalize text & url of matched result
*       (for example, for @twitter mentions).
*
* `options`:
*
* - __fuzzyLink__ - recognige URL-s without `http(s):` prefix. Default `true`.
* - __fuzzyIP__ - allow IPs in fuzzy links above. Can conflict with some texts
*   like version numbers. Default `false`.
* - __fuzzyEmail__ - recognize emails without `mailto:` prefix.
*
**/
function LinkifyIt(schemas, options) {
	if (!(this instanceof LinkifyIt)) return new LinkifyIt(schemas, options);
	if (!options) {
		if (isOptionsObj(schemas)) {
			options = schemas;
			schemas = {};
		}
	}
	this.__opts__ = assign({}, defaultOptions, options);
	this.__index__ = -1;
	this.__last_index__ = -1;
	this.__schema__ = "";
	this.__text_cache__ = "";
	this.__schemas__ = assign({}, defaultSchemas, schemas);
	this.__compiled__ = {};
	this.__tlds__ = tlds_default;
	this.__tlds_replaced__ = false;
	this.re = {};
	compile(this);
}
/** chainable
* LinkifyIt#add(schema, definition)
* - schema (String): rule name (fixed pattern prefix)
* - definition (String|RegExp|Object): schema definition
*
* Add new rule definition. See constructor description for details.
**/
LinkifyIt.prototype.add = function add(schema, definition) {
	this.__schemas__[schema] = definition;
	compile(this);
	return this;
};
/** chainable
* LinkifyIt#set(options)
* - options (Object): { fuzzyLink|fuzzyEmail|fuzzyIP: true|false }
*
* Set recognition options for links without schema.
**/
LinkifyIt.prototype.set = function set(options) {
	this.__opts__ = assign(this.__opts__, options);
	return this;
};
/**
* LinkifyIt#test(text) -> Boolean
*
* Searches linkifiable pattern and returns `true` on success or `false` on fail.
**/
LinkifyIt.prototype.test = function test(text) {
	this.__text_cache__ = text;
	this.__index__ = -1;
	if (!text.length) return false;
	let m, ml, me, len, shift, next, re, tld_pos, at_pos;
	if (this.re.schema_test.test(text)) {
		re = this.re.schema_search;
		re.lastIndex = 0;
		while ((m = re.exec(text)) !== null) {
			len = this.testSchemaAt(text, m[2], re.lastIndex);
			if (len) {
				this.__schema__ = m[2];
				this.__index__ = m.index + m[1].length;
				this.__last_index__ = m.index + m[0].length + len;
				break;
			}
		}
	}
	if (this.__opts__.fuzzyLink && this.__compiled__["http:"]) {
		tld_pos = text.search(this.re.host_fuzzy_test);
		if (tld_pos >= 0) {
			if (this.__index__ < 0 || tld_pos < this.__index__) {
				if ((ml = text.match(this.__opts__.fuzzyIP ? this.re.link_fuzzy : this.re.link_no_ip_fuzzy)) !== null) {
					shift = ml.index + ml[1].length;
					if (this.__index__ < 0 || shift < this.__index__) {
						this.__schema__ = "";
						this.__index__ = shift;
						this.__last_index__ = ml.index + ml[0].length;
					}
				}
			}
		}
	}
	if (this.__opts__.fuzzyEmail && this.__compiled__["mailto:"]) {
		at_pos = text.indexOf("@");
		if (at_pos >= 0) {
			if ((me = text.match(this.re.email_fuzzy)) !== null) {
				shift = me.index + me[1].length;
				next = me.index + me[0].length;
				if (this.__index__ < 0 || shift < this.__index__ || shift === this.__index__ && next > this.__last_index__) {
					this.__schema__ = "mailto:";
					this.__index__ = shift;
					this.__last_index__ = next;
				}
			}
		}
	}
	return this.__index__ >= 0;
};
/**
* LinkifyIt#pretest(text) -> Boolean
*
* Very quick check, that can give false positives. Returns true if link MAY BE
* can exists. Can be used for speed optimization, when you need to check that
* link NOT exists.
**/
LinkifyIt.prototype.pretest = function pretest(text) {
	return this.re.pretest.test(text);
};
/**
* LinkifyIt#testSchemaAt(text, name, position) -> Number
* - text (String): text to scan
* - name (String): rule (schema) name
* - position (Number): text offset to check from
*
* Similar to [[LinkifyIt#test]] but checks only specific protocol tail exactly
* at given position. Returns length of found pattern (0 on fail).
**/
LinkifyIt.prototype.testSchemaAt = function testSchemaAt(text, schema, pos) {
	if (!this.__compiled__[schema.toLowerCase()]) return 0;
	return this.__compiled__[schema.toLowerCase()].validate(text, pos, this);
};
/**
* LinkifyIt#match(text) -> Array|null
*
* Returns array of found link descriptions or `null` on fail. We strongly
* recommend to use [[LinkifyIt#test]] first, for best speed.
*
* ##### Result match description
*
* - __schema__ - link schema, can be empty for fuzzy links, or `//` for
*   protocol-neutral  links.
* - __index__ - offset of matched text
* - __lastIndex__ - index of next char after mathch end
* - __raw__ - matched text
* - __text__ - normalized text
* - __url__ - link, generated from matched text
**/
LinkifyIt.prototype.match = function match(text) {
	const result = [];
	let shift = 0;
	if (this.__index__ >= 0 && this.__text_cache__ === text) {
		result.push(createMatch(this, shift));
		shift = this.__last_index__;
	}
	let tail = shift ? text.slice(shift) : text;
	while (this.test(tail)) {
		result.push(createMatch(this, shift));
		tail = tail.slice(this.__last_index__);
		shift += this.__last_index__;
	}
	if (result.length) return result;
	return null;
};
/**
* LinkifyIt#matchAtStart(text) -> Match|null
*
* Returns fully-formed (not fuzzy) link if it starts at the beginning
* of the string, and null otherwise.
**/
LinkifyIt.prototype.matchAtStart = function matchAtStart(text) {
	this.__text_cache__ = text;
	this.__index__ = -1;
	if (!text.length) return null;
	const m = this.re.schema_at_start.exec(text);
	if (!m) return null;
	const len = this.testSchemaAt(text, m[2], m[0].length);
	if (!len) return null;
	this.__schema__ = m[2];
	this.__index__ = m.index + m[1].length;
	this.__last_index__ = m.index + m[0].length + len;
	return createMatch(this, 0);
};
/** chainable
* LinkifyIt#tlds(list [, keepOld]) -> this
* - list (Array): list of tlds
* - keepOld (Boolean): merge with current list if `true` (`false` by default)
*
* Load (or merge) new tlds list. Those are user for fuzzy links (without prefix)
* to avoid false positives. By default this algorythm used:
*
* - hostname with any 2-letter root zones are ok.
* - biz|com|edu|gov|net|org|pro|web|xxx|aero|asia|coop|info|museum|name|shop|рф
*   are ok.
* - encoded (`xn--...`) root zones are ok.
*
* If list is replaced, then exact match for 2-chars root zones will be checked.
**/
LinkifyIt.prototype.tlds = function tlds(list, keepOld) {
	list = Array.isArray(list) ? list : [list];
	if (!keepOld) {
		this.__tlds__ = list.slice();
		this.__tlds_replaced__ = true;
		compile(this);
		return this;
	}
	this.__tlds__ = this.__tlds__.concat(list).sort().filter(function(el, idx, arr) {
		return el !== arr[idx - 1];
	}).reverse();
	compile(this);
	return this;
};
/**
* LinkifyIt#normalize(match)
*
* Default normalizer (if schema does not define it's own).
**/
LinkifyIt.prototype.normalize = function normalize(match) {
	if (!match.schema) match.url = "http://" + match.url;
	if (match.schema === "mailto:" && !/^mailto:/i.test(match.url)) match.url = "mailto:" + match.url;
};
/**
* LinkifyIt#onCompile()
*
* Override to modify basic RegExp-s.
**/
LinkifyIt.prototype.onCompile = function onCompile() {};
/** Highest positive signed 32-bit float value */
const maxInt = 2147483647;
/** Bootstring parameters */
const base = 36;
const tMin = 1;
const tMax = 26;
const skew = 38;
const damp = 700;
const initialBias = 72;
const initialN = 128;
const delimiter = "-";
/** Regular expressions */
const regexPunycode = /^xn--/;
const regexNonASCII = /[^\0-\x7F]/;
const regexSeparators = /[\x2E\u3002\uFF0E\uFF61]/g;
/** Error messages */
const errors = {
	"overflow": "Overflow: input needs wider integers to process",
	"not-basic": "Illegal input >= 0x80 (not a basic code point)",
	"invalid-input": "Invalid input"
};
/** Convenience shortcuts */
const baseMinusTMin = base - tMin;
const floor = Math.floor;
const stringFromCharCode = String.fromCharCode;
/**
* A generic error utility function.
* @private
* @param {String} type The error type.
* @returns {Error} Throws a `RangeError` with the applicable error message.
*/
function error(type) {
	throw new RangeError(errors[type]);
}
/**
* A generic `Array#map` utility function.
* @private
* @param {Array} array The array to iterate over.
* @param {Function} callback The function that gets called for every array
* item.
* @returns {Array} A new array of values returned by the callback function.
*/
function map(array, callback) {
	const result = [];
	let length = array.length;
	while (length--) result[length] = callback(array[length]);
	return result;
}
/**
* A simple `Array#map`-like wrapper to work with domain name strings or email
* addresses.
* @private
* @param {String} domain The domain name or email address.
* @param {Function} callback The function that gets called for every
* character.
* @returns {String} A new string of characters returned by the callback
* function.
*/
function mapDomain(domain, callback) {
	const parts = domain.split("@");
	let result = "";
	if (parts.length > 1) {
		result = parts[0] + "@";
		domain = parts[1];
	}
	domain = domain.replace(regexSeparators, ".");
	const encoded = map(domain.split("."), callback).join(".");
	return result + encoded;
}
/**
* Creates an array containing the numeric code points of each Unicode
* character in the string. While JavaScript uses UCS-2 internally,
* this function will convert a pair of surrogate halves (each of which
* UCS-2 exposes as separate characters) into a single code point,
* matching UTF-16.
* @see `punycode.ucs2.encode`
* @see <https://mathiasbynens.be/notes/javascript-encoding>
* @memberOf punycode.ucs2
* @name decode
* @param {String} string The Unicode input string (UCS-2).
* @returns {Array} The new array of code points.
*/
function ucs2decode(string) {
	const output = [];
	let counter = 0;
	const length = string.length;
	while (counter < length) {
		const value = string.charCodeAt(counter++);
		if (value >= 55296 && value <= 56319 && counter < length) {
			const extra = string.charCodeAt(counter++);
			if ((extra & 64512) == 56320) output.push(((value & 1023) << 10) + (extra & 1023) + 65536);
			else {
				output.push(value);
				counter--;
			}
		} else output.push(value);
	}
	return output;
}
/**
* Creates a string based on an array of numeric code points.
* @see `punycode.ucs2.decode`
* @memberOf punycode.ucs2
* @name encode
* @param {Array} codePoints The array of numeric code points.
* @returns {String} The new Unicode string (UCS-2).
*/
const ucs2encode = (codePoints) => String.fromCodePoint(...codePoints);
/**
* Converts a basic code point into a digit/integer.
* @see `digitToBasic()`
* @private
* @param {Number} codePoint The basic numeric code point value.
* @returns {Number} The numeric value of a basic code point (for use in
* representing integers) in the range `0` to `base - 1`, or `base` if
* the code point does not represent a value.
*/
const basicToDigit = function(codePoint) {
	if (codePoint >= 48 && codePoint < 58) return 26 + (codePoint - 48);
	if (codePoint >= 65 && codePoint < 91) return codePoint - 65;
	if (codePoint >= 97 && codePoint < 123) return codePoint - 97;
	return base;
};
/**
* Converts a digit/integer into a basic code point.
* @see `basicToDigit()`
* @private
* @param {Number} digit The numeric value of a basic code point.
* @returns {Number} The basic code point whose value (when used for
* representing integers) is `digit`, which needs to be in the range
* `0` to `base - 1`. If `flag` is non-zero, the uppercase form is
* used; else, the lowercase form is used. The behavior is undefined
* if `flag` is non-zero and `digit` has no uppercase form.
*/
const digitToBasic = function(digit, flag) {
	return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
};
/**
* Bias adaptation function as per section 3.4 of RFC 3492.
* https://tools.ietf.org/html/rfc3492#section-3.4
* @private
*/
const adapt = function(delta, numPoints, firstTime) {
	let k = 0;
	delta = firstTime ? floor(delta / damp) : delta >> 1;
	delta += floor(delta / numPoints);
	for (; delta > baseMinusTMin * tMax >> 1; k += base) delta = floor(delta / baseMinusTMin);
	return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
};
/**
* Converts a Punycode string of ASCII-only symbols to a string of Unicode
* symbols.
* @memberOf punycode
* @param {String} input The Punycode string of ASCII-only symbols.
* @returns {String} The resulting string of Unicode symbols.
*/
const decode = function(input) {
	const output = [];
	const inputLength = input.length;
	let i = 0;
	let n = initialN;
	let bias = initialBias;
	let basic = input.lastIndexOf(delimiter);
	if (basic < 0) basic = 0;
	for (let j = 0; j < basic; ++j) {
		if (input.charCodeAt(j) >= 128) error("not-basic");
		output.push(input.charCodeAt(j));
	}
	for (let index = basic > 0 ? basic + 1 : 0; index < inputLength;) {
		const oldi = i;
		for (let w = 1, k = base;; k += base) {
			if (index >= inputLength) error("invalid-input");
			const digit = basicToDigit(input.charCodeAt(index++));
			if (digit >= base) error("invalid-input");
			if (digit > floor((maxInt - i) / w)) error("overflow");
			i += digit * w;
			const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
			if (digit < t) break;
			const baseMinusT = base - t;
			if (w > floor(maxInt / baseMinusT)) error("overflow");
			w *= baseMinusT;
		}
		const out = output.length + 1;
		bias = adapt(i - oldi, out, oldi == 0);
		if (floor(i / out) > maxInt - n) error("overflow");
		n += floor(i / out);
		i %= out;
		output.splice(i++, 0, n);
	}
	return String.fromCodePoint(...output);
};
/**
* Converts a string of Unicode symbols (e.g. a domain name label) to a
* Punycode string of ASCII-only symbols.
* @memberOf punycode
* @param {String} input The string of Unicode symbols.
* @returns {String} The resulting Punycode string of ASCII-only symbols.
*/
const encode = function(input) {
	const output = [];
	input = ucs2decode(input);
	const inputLength = input.length;
	let n = initialN;
	let delta = 0;
	let bias = initialBias;
	for (const currentValue of input) if (currentValue < 128) output.push(stringFromCharCode(currentValue));
	const basicLength = output.length;
	let handledCPCount = basicLength;
	if (basicLength) output.push(delimiter);
	while (handledCPCount < inputLength) {
		let m = maxInt;
		for (const currentValue of input) if (currentValue >= n && currentValue < m) m = currentValue;
		const handledCPCountPlusOne = handledCPCount + 1;
		if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) error("overflow");
		delta += (m - n) * handledCPCountPlusOne;
		n = m;
		for (const currentValue of input) {
			if (currentValue < n && ++delta > maxInt) error("overflow");
			if (currentValue === n) {
				let q = delta;
				for (let k = base;; k += base) {
					const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
					if (q < t) break;
					const qMinusT = q - t;
					const baseMinusT = base - t;
					output.push(stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0)));
					q = floor(qMinusT / baseMinusT);
				}
				output.push(stringFromCharCode(digitToBasic(q, 0)));
				bias = adapt(delta, handledCPCountPlusOne, handledCPCount === basicLength);
				delta = 0;
				++handledCPCount;
			}
		}
		++delta;
		++n;
	}
	return output.join("");
};
/**
* Converts a Punycode string representing a domain name or an email address
* to Unicode. Only the Punycoded parts of the input will be converted, i.e.
* it doesn't matter if you call it on a string that has already been
* converted to Unicode.
* @memberOf punycode
* @param {String} input The Punycoded domain name or email address to
* convert to Unicode.
* @returns {String} The Unicode representation of the given Punycode
* string.
*/
const toUnicode = function(input) {
	return mapDomain(input, function(string) {
		return regexPunycode.test(string) ? decode(string.slice(4).toLowerCase()) : string;
	});
};
/**
* Converts a Unicode string representing a domain name or an email address to
* Punycode. Only the non-ASCII parts of the domain name will be converted,
* i.e. it doesn't matter if you call it with a domain that's already in
* ASCII.
* @memberOf punycode
* @param {String} input The domain name or email address to convert, as a
* Unicode string.
* @returns {String} The Punycode representation of the given domain name or
* email address.
*/
const toASCII = function(input) {
	return mapDomain(input, function(string) {
		return regexNonASCII.test(string) ? "xn--" + encode(string) : string;
	});
};
/** Define the public API */
const punycode = {
	"version": "2.3.1",
	"ucs2": {
		"decode": ucs2decode,
		"encode": ucs2encode
	},
	"decode": decode,
	"encode": encode,
	"toASCII": toASCII,
	"toUnicode": toUnicode
};
const config = {
	default: {
		options: {
			html: false,
			xhtmlOut: false,
			breaks: false,
			langPrefix: "language-",
			linkify: false,
			typographer: false,
			quotes: "“”‘’",
			highlight: null,
			maxNesting: 100
		},
		components: {
			core: {},
			block: {},
			inline: {}
		}
	},
	zero: {
		options: {
			html: false,
			xhtmlOut: false,
			breaks: false,
			langPrefix: "language-",
			linkify: false,
			typographer: false,
			quotes: "“”‘’",
			highlight: null,
			maxNesting: 20
		},
		components: {
			core: { rules: [
				"normalize",
				"block",
				"inline",
				"text_join"
			] },
			block: { rules: ["paragraph"] },
			inline: {
				rules: ["text"],
				rules2: ["balance_pairs", "fragments_join"]
			}
		}
	},
	commonmark: {
		options: {
			html: true,
			xhtmlOut: true,
			breaks: false,
			langPrefix: "language-",
			linkify: false,
			typographer: false,
			quotes: "“”‘’",
			highlight: null,
			maxNesting: 20
		},
		components: {
			core: { rules: [
				"normalize",
				"block",
				"inline",
				"text_join"
			] },
			block: { rules: [
				"blockquote",
				"code",
				"fence",
				"heading",
				"hr",
				"html_block",
				"lheading",
				"list",
				"reference",
				"paragraph"
			] },
			inline: {
				rules: [
					"autolink",
					"backticks",
					"emphasis",
					"entity",
					"escape",
					"html_inline",
					"image",
					"link",
					"newline",
					"text"
				],
				rules2: [
					"balance_pairs",
					"emphasis",
					"fragments_join"
				]
			}
		}
	}
};
const BAD_PROTO_RE = /^(vbscript|javascript|file|data):/;
const GOOD_DATA_RE = /^data:image\/(gif|png|jpeg|webp);/;
function validateLink(url) {
	const str = url.trim().toLowerCase();
	return BAD_PROTO_RE.test(str) ? GOOD_DATA_RE.test(str) : true;
}
const RECODE_HOSTNAME_FOR = [
	"http:",
	"https:",
	"mailto:"
];
function normalizeLink(url) {
	const parsed = urlParse(url, true);
	if (parsed.hostname) {
		if (!parsed.protocol || RECODE_HOSTNAME_FOR.indexOf(parsed.protocol) >= 0) try {
			parsed.hostname = punycode.toASCII(parsed.hostname);
		} catch (er) {}
	}
	return encode$2(format(parsed));
}
function normalizeLinkText(url) {
	const parsed = urlParse(url, true);
	if (parsed.hostname) {
		if (!parsed.protocol || RECODE_HOSTNAME_FOR.indexOf(parsed.protocol) >= 0) try {
			parsed.hostname = punycode.toUnicode(parsed.hostname);
		} catch (er) {}
	}
	return decode$2(format(parsed), decode$2.defaultChars + "%");
}
/**
* class MarkdownIt
*
* Main parser/renderer class.
*
* ##### Usage
*
* ```javascript
* // node.js, "classic" way:
* var MarkdownIt = require('markdown-it'),
*     md = new MarkdownIt();
* var result = md.render('# markdown-it rulezz!');
*
* // node.js, the same, but with sugar:
* var md = require('markdown-it')();
* var result = md.render('# markdown-it rulezz!');
*
* // browser without AMD, added to "window" on script load
* // Note, there are no dash.
* var md = window.markdownit();
* var result = md.render('# markdown-it rulezz!');
* ```
*
* Single line rendering, without paragraph wrap:
*
* ```javascript
* var md = require('markdown-it')();
* var result = md.renderInline('__markdown-it__ rulezz!');
* ```
**/
/**
* new MarkdownIt([presetName, options])
* - presetName (String): optional, `commonmark` / `zero`
* - options (Object)
*
* Creates parser instanse with given config. Can be called without `new`.
*
* ##### presetName
*
* MarkdownIt provides named presets as a convenience to quickly
* enable/disable active syntax rules and options for common use cases.
*
* - ["commonmark"](https://github.com/markdown-it/markdown-it/blob/master/lib/presets/commonmark.mjs) -
*   configures parser to strict [CommonMark](http://commonmark.org/) mode.
* - [default](https://github.com/markdown-it/markdown-it/blob/master/lib/presets/default.mjs) -
*   similar to GFM, used when no preset name given. Enables all available rules,
*   but still without html, typographer & autolinker.
* - ["zero"](https://github.com/markdown-it/markdown-it/blob/master/lib/presets/zero.mjs) -
*   all rules disabled. Useful to quickly setup your config via `.enable()`.
*   For example, when you need only `bold` and `italic` markup and nothing else.
*
* ##### options:
*
* - __html__ - `false`. Set `true` to enable HTML tags in source. Be careful!
*   That's not safe! You may need external sanitizer to protect output from XSS.
*   It's better to extend features via plugins, instead of enabling HTML.
* - __xhtmlOut__ - `false`. Set `true` to add '/' when closing single tags
*   (`<br />`). This is needed only for full CommonMark compatibility. In real
*   world you will need HTML output.
* - __breaks__ - `false`. Set `true` to convert `\n` in paragraphs into `<br>`.
* - __langPrefix__ - `language-`. CSS language class prefix for fenced blocks.
*   Can be useful for external highlighters.
* - __linkify__ - `false`. Set `true` to autoconvert URL-like text to links.
* - __typographer__  - `false`. Set `true` to enable [some language-neutral
*   replacement](https://github.com/markdown-it/markdown-it/blob/master/lib/rules_core/replacements.mjs) +
*   quotes beautification (smartquotes).
* - __quotes__ - `“”‘’`, String or Array. Double + single quotes replacement
*   pairs, when typographer enabled and smartquotes on. For example, you can
*   use `'«»„“'` for Russian, `'„“‚‘'` for German, and
*   `['«\xA0', '\xA0»', '‹\xA0', '\xA0›']` for French (including nbsp).
* - __highlight__ - `null`. Highlighter function for fenced code blocks.
*   Highlighter `function (str, lang)` should return escaped HTML. It can also
*   return empty string if the source was not changed and should be escaped
*   externaly. If result starts with <pre... internal wrapper is skipped.
*
* ##### Example
*
* ```javascript
* // commonmark mode
* var md = require('markdown-it')('commonmark');
*
* // default mode
* var md = require('markdown-it')();
*
* // enable everything
* var md = require('markdown-it')({
*   html: true,
*   linkify: true,
*   typographer: true
* });
* ```
*
* ##### Syntax highlighting
*
* ```js
* var hljs = require('highlight.js') // https://highlightjs.org/
*
* var md = require('markdown-it')({
*   highlight: function (str, lang) {
*     if (lang && hljs.getLanguage(lang)) {
*       try {
*         return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
*       } catch (__) {}
*     }
*
*     return ''; // use external default escaping
*   }
* });
* ```
*
* Or with full wrapper override (if you need assign class to `<pre>` or `<code>`):
*
* ```javascript
* var hljs = require('highlight.js') // https://highlightjs.org/
*
* // Actual default values
* var md = require('markdown-it')({
*   highlight: function (str, lang) {
*     if (lang && hljs.getLanguage(lang)) {
*       try {
*         return '<pre><code class="hljs">' +
*                hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
*                '</code></pre>';
*       } catch (__) {}
*     }
*
*     return '<pre><code class="hljs">' + md.utils.escapeHtml(str) + '</code></pre>';
*   }
* });
* ```
*
**/
function MarkdownIt(presetName, options) {
	if (!(this instanceof MarkdownIt)) return new MarkdownIt(presetName, options);
	if (!options) {
		if (!isString$1(presetName)) {
			options = presetName || {};
			presetName = "default";
		}
	}
	/**
	* MarkdownIt#inline -> ParserInline
	*
	* Instance of [[ParserInline]]. You may need it to add new rules when
	* writing plugins. For simple rules control use [[MarkdownIt.disable]] and
	* [[MarkdownIt.enable]].
	**/
	this.inline = new ParserInline();
	/**
	* MarkdownIt#block -> ParserBlock
	*
	* Instance of [[ParserBlock]]. You may need it to add new rules when
	* writing plugins. For simple rules control use [[MarkdownIt.disable]] and
	* [[MarkdownIt.enable]].
	**/
	this.block = new ParserBlock();
	/**
	* MarkdownIt#core -> Core
	*
	* Instance of [[Core]] chain executor. You may need it to add new rules when
	* writing plugins. For simple rules control use [[MarkdownIt.disable]] and
	* [[MarkdownIt.enable]].
	**/
	this.core = new Core();
	/**
	* MarkdownIt#renderer -> Renderer
	*
	* Instance of [[Renderer]]. Use it to modify output look. Or to add rendering
	* rules for new token types, generated by plugins.
	*
	* ##### Example
	*
	* ```javascript
	* var md = require('markdown-it')();
	*
	* function myToken(tokens, idx, options, env, self) {
	*   //...
	*   return result;
	* };
	*
	* md.renderer.rules['my_token'] = myToken
	* ```
	*
	* See [[Renderer]] docs and [source code](https://github.com/markdown-it/markdown-it/blob/master/lib/renderer.mjs).
	**/
	this.renderer = new Renderer();
	/**
	* MarkdownIt#linkify -> LinkifyIt
	*
	* [linkify-it](https://github.com/markdown-it/linkify-it) instance.
	* Used by [linkify](https://github.com/markdown-it/markdown-it/blob/master/lib/rules_core/linkify.mjs)
	* rule.
	**/
	this.linkify = new LinkifyIt();
	/**
	* MarkdownIt#validateLink(url) -> Boolean
	*
	* Link validation function. CommonMark allows too much in links. By default
	* we disable `javascript:`, `vbscript:`, `file:` schemas, and almost all `data:...` schemas
	* except some embedded image types.
	*
	* You can change this behaviour:
	*
	* ```javascript
	* var md = require('markdown-it')();
	* // enable everything
	* md.validateLink = function () { return true; }
	* ```
	**/
	this.validateLink = validateLink;
	/**
	* MarkdownIt#normalizeLink(url) -> String
	*
	* Function used to encode link url to a machine-readable format,
	* which includes url-encoding, punycode, etc.
	**/
	this.normalizeLink = normalizeLink;
	/**
	* MarkdownIt#normalizeLinkText(url) -> String
	*
	* Function used to decode link url to a human-readable format`
	**/
	this.normalizeLinkText = normalizeLinkText;
	/**
	* MarkdownIt#utils -> utils
	*
	* Assorted utility functions, useful to write plugins. See details
	* [here](https://github.com/markdown-it/markdown-it/blob/master/lib/common/utils.mjs).
	**/
	this.utils = utils_exports;
	/**
	* MarkdownIt#helpers -> helpers
	*
	* Link components parser functions, useful to write plugins. See details
	* [here](https://github.com/markdown-it/markdown-it/blob/master/lib/helpers).
	**/
	this.helpers = assign$1({}, helpers_exports);
	this.options = {};
	this.configure(presetName);
	if (options) this.set(options);
}
/** chainable
* MarkdownIt.set(options)
*
* Set parser options (in the same format as in constructor). Probably, you
* will never need it, but you can change options after constructor call.
*
* ##### Example
*
* ```javascript
* var md = require('markdown-it')()
*             .set({ html: true, breaks: true })
*             .set({ typographer, true });
* ```
*
* __Note:__ To achieve the best possible performance, don't modify a
* `markdown-it` instance options on the fly. If you need multiple configurations
* it's best to create multiple instances and initialize each with separate
* config.
**/
MarkdownIt.prototype.set = function(options) {
	assign$1(this.options, options);
	return this;
};
/** chainable, internal
* MarkdownIt.configure(presets)
*
* Batch load of all options and compenent settings. This is internal method,
* and you probably will not need it. But if you will - see available presets
* and data structure [here](https://github.com/markdown-it/markdown-it/tree/master/lib/presets)
*
* We strongly recommend to use presets instead of direct config loads. That
* will give better compatibility with next versions.
**/
MarkdownIt.prototype.configure = function(presets) {
	const self = this;
	if (isString$1(presets)) {
		const presetName = presets;
		presets = config[presetName];
		if (!presets) throw new Error("Wrong `markdown-it` preset \"" + presetName + "\", check name");
	}
	if (!presets) throw new Error("Wrong `markdown-it` preset, can't be empty");
	if (presets.options) self.set(presets.options);
	if (presets.components) Object.keys(presets.components).forEach(function(name) {
		if (presets.components[name].rules) self[name].ruler.enableOnly(presets.components[name].rules);
		if (presets.components[name].rules2) self[name].ruler2.enableOnly(presets.components[name].rules2);
	});
	return this;
};
/** chainable
* MarkdownIt.enable(list, ignoreInvalid)
* - list (String|Array): rule name or list of rule names to enable
* - ignoreInvalid (Boolean): set `true` to ignore errors when rule not found.
*
* Enable list or rules. It will automatically find appropriate components,
* containing rules with given names. If rule not found, and `ignoreInvalid`
* not set - throws exception.
*
* ##### Example
*
* ```javascript
* var md = require('markdown-it')()
*             .enable(['sub', 'sup'])
*             .disable('smartquotes');
* ```
**/
MarkdownIt.prototype.enable = function(list, ignoreInvalid) {
	let result = [];
	if (!Array.isArray(list)) list = [list];
	[
		"core",
		"block",
		"inline"
	].forEach(function(chain) {
		result = result.concat(this[chain].ruler.enable(list, true));
	}, this);
	result = result.concat(this.inline.ruler2.enable(list, true));
	const missed = list.filter(function(name) {
		return result.indexOf(name) < 0;
	});
	if (missed.length && !ignoreInvalid) throw new Error("MarkdownIt. Failed to enable unknown rule(s): " + missed);
	return this;
};
/** chainable
* MarkdownIt.disable(list, ignoreInvalid)
* - list (String|Array): rule name or list of rule names to disable.
* - ignoreInvalid (Boolean): set `true` to ignore errors when rule not found.
*
* The same as [[MarkdownIt.enable]], but turn specified rules off.
**/
MarkdownIt.prototype.disable = function(list, ignoreInvalid) {
	let result = [];
	if (!Array.isArray(list)) list = [list];
	[
		"core",
		"block",
		"inline"
	].forEach(function(chain) {
		result = result.concat(this[chain].ruler.disable(list, true));
	}, this);
	result = result.concat(this.inline.ruler2.disable(list, true));
	const missed = list.filter(function(name) {
		return result.indexOf(name) < 0;
	});
	if (missed.length && !ignoreInvalid) throw new Error("MarkdownIt. Failed to disable unknown rule(s): " + missed);
	return this;
};
/** chainable
* MarkdownIt.use(plugin, params)
*
* Load specified plugin with given params into current parser instance.
* It's just a sugar to call `plugin(md, params)` with curring.
*
* ##### Example
*
* ```javascript
* var iterator = require('markdown-it-for-inline');
* var md = require('markdown-it')()
*             .use(iterator, 'foo_replace', 'text', function (tokens, idx) {
*               tokens[idx].content = tokens[idx].content.replace(/foo/g, 'bar');
*             });
* ```
**/
MarkdownIt.prototype.use = function(plugin) {
	const args = [this].concat(Array.prototype.slice.call(arguments, 1));
	plugin.apply(plugin, args);
	return this;
};
/** internal
* MarkdownIt.parse(src, env) -> Array
* - src (String): source string
* - env (Object): environment sandbox
*
* Parse input string and return list of block tokens (special token type
* "inline" will contain list of inline tokens). You should not call this
* method directly, until you write custom renderer (for example, to produce
* AST).
*
* `env` is used to pass data between "distributed" rules and return additional
* metadata like reference info, needed for the renderer. It also can be used to
* inject data in specific cases. Usually, you will be ok to pass `{}`,
* and then pass updated object to renderer.
**/
MarkdownIt.prototype.parse = function(src, env) {
	if (typeof src !== "string") throw new Error("Input data should be a String");
	const state = new this.core.State(src, this, env);
	this.core.process(state);
	return state.tokens;
};
/**
* MarkdownIt.render(src [, env]) -> String
* - src (String): source string
* - env (Object): environment sandbox
*
* Render markdown string into html. It does all magic for you :).
*
* `env` can be used to inject additional metadata (`{}` by default).
* But you will not need it with high probability. See also comment
* in [[MarkdownIt.parse]].
**/
MarkdownIt.prototype.render = function(src, env) {
	env = env || {};
	return this.renderer.render(this.parse(src, env), this.options, env);
};
/** internal
* MarkdownIt.parseInline(src, env) -> Array
* - src (String): source string
* - env (Object): environment sandbox
*
* The same as [[MarkdownIt.parse]] but skip all block rules. It returns the
* block tokens list with the single `inline` element, containing parsed inline
* tokens in `children` property. Also updates `env` object.
**/
MarkdownIt.prototype.parseInline = function(src, env) {
	const state = new this.core.State(src, this, env);
	state.inlineMode = true;
	this.core.process(state);
	return state.tokens;
};
/**
* MarkdownIt.renderInline(src [, env]) -> String
* - src (String): source string
* - env (Object): environment sandbox
*
* Similar to [[MarkdownIt.render]] but for single paragraph content. Result
* will NOT be wrapped into `<p>` tags.
**/
MarkdownIt.prototype.renderInline = function(src, env) {
	env = env || {};
	return this.renderer.render(this.parseInline(src, env), this.options, env);
};
/**
* This is only safe for (and intended to be used for) text node positions. If
* you are using attribute position, then this is only safe if the attribute
* value is surrounded by double-quotes, and is unsafe otherwise (because the
* value could break out of the attribute value and e.g. add another attribute).
*/
function escapeNodeText(str) {
	const frag = document.createElement("div");
	D(b`${str}`, frag);
	return frag.innerHTML.replaceAll(/<!--([^-]*)-->/gim, "");
}
var MarkdownDirective = class extends i$5 {
	#markdownIt = MarkdownIt({ highlight: (str, lang) => {
		switch (lang) {
			case "html": {
				const iframe = document.createElement("iframe");
				iframe.classList.add("html-view");
				iframe.srcdoc = str;
				iframe.sandbox = "";
				return iframe.innerHTML;
			}
			default: return escapeNodeText(str);
		}
	} });
	#lastValue = null;
	#lastTagClassMap = null;
	update(_part, [value, tagClassMap]) {
		if (this.#lastValue === value && JSON.stringify(tagClassMap) === this.#lastTagClassMap) return E;
		this.#lastValue = value;
		this.#lastTagClassMap = JSON.stringify(tagClassMap);
		return this.render(value, tagClassMap);
	}
	#originalClassMap = /* @__PURE__ */ new Map();
	#applyTagClassMap(tagClassMap) {
		Object.entries(tagClassMap).forEach(([tag]) => {
			let tokenName;
			switch (tag) {
				case "p":
					tokenName = "paragraph";
					break;
				case "h1":
				case "h2":
				case "h3":
				case "h4":
				case "h5":
				case "h6":
					tokenName = "heading";
					break;
				case "ul":
					tokenName = "bullet_list";
					break;
				case "ol":
					tokenName = "ordered_list";
					break;
				case "li":
					tokenName = "list_item";
					break;
				case "a":
					tokenName = "link";
					break;
				case "strong":
					tokenName = "strong";
					break;
				case "em":
					tokenName = "em";
					break;
			}
			if (!tokenName) return;
			const key = `${tokenName}_open`;
			this.#markdownIt.renderer.rules[key] = (tokens, idx, options, _env, self) => {
				const token = tokens[idx];
				const tokenClasses = tagClassMap[token.tag] ?? [];
				for (const clazz of tokenClasses) token.attrJoin("class", clazz);
				return self.renderToken(tokens, idx, options);
			};
		});
	}
	#unapplyTagClassMap() {
		for (const [key] of this.#originalClassMap) delete this.#markdownIt.renderer.rules[key];
		this.#originalClassMap.clear();
	}
	/**
	* Renders the markdown string to HTML using MarkdownIt.
	*
	* Note: MarkdownIt doesn't enable HTML in its output, so we render the
	* value directly without further sanitization.
	* @see https://github.com/markdown-it/markdown-it/blob/master/docs/security.md
	*/
	render(value, tagClassMap) {
		if (tagClassMap) this.#applyTagClassMap(tagClassMap);
		const htmlString = this.#markdownIt.render(value);
		this.#unapplyTagClassMap();
		return o(htmlString);
	}
};
const markdown = e$10(MarkdownDirective);
MarkdownIt();
var __esDecorate$1 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers$1 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$1("a2ui-text")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _text_decorators;
	let _text_initializers = [];
	let _text_extraInitializers = [];
	let _usageHint_decorators;
	let _usageHint_initializers = [];
	let _usageHint_extraInitializers = [];
	var Text = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_text_decorators = [n$6()];
			_usageHint_decorators = [n$6({
				reflect: true,
				attribute: "usage-hint"
			})];
			__esDecorate$1(this, null, _text_decorators, {
				kind: "accessor",
				name: "text",
				static: false,
				private: false,
				access: {
					has: (obj) => "text" in obj,
					get: (obj) => obj.text,
					set: (obj, value) => {
						obj.text = value;
					}
				},
				metadata: _metadata
			}, _text_initializers, _text_extraInitializers);
			__esDecorate$1(this, null, _usageHint_decorators, {
				kind: "accessor",
				name: "usageHint",
				static: false,
				private: false,
				access: {
					has: (obj) => "usageHint" in obj,
					get: (obj) => obj.usageHint,
					set: (obj, value) => {
						obj.usageHint = value;
					}
				},
				metadata: _metadata
			}, _usageHint_initializers, _usageHint_extraInitializers);
			__esDecorate$1(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Text = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#text_accessor_storage = __runInitializers$1(this, _text_initializers, null);
		get text() {
			return this.#text_accessor_storage;
		}
		set text(value) {
			this.#text_accessor_storage = value;
		}
		#usageHint_accessor_storage = (__runInitializers$1(this, _text_extraInitializers), __runInitializers$1(this, _usageHint_initializers, null));
		get usageHint() {
			return this.#usageHint_accessor_storage;
		}
		set usageHint(value) {
			this.#usageHint_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$9`
      :host {
        display: block;
        flex: var(--weight);
      }

      h1,
      h2,
      h3,
      h4,
      h5 {
        line-height: inherit;
        font: inherit;
      }
    `];
		}
		#renderText() {
			let textValue = null;
			if (this.text && typeof this.text === "object") {
				if ("literalString" in this.text && this.text.literalString) textValue = this.text.literalString;
				else if ("literal" in this.text && this.text.literal !== void 0) textValue = this.text.literal;
				else if (this.text && "path" in this.text && this.text.path) {
					if (!this.processor || !this.component) return b`(no model)`;
					const value = this.processor.getData(this.component, this.text.path, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
					if (value !== null && value !== void 0) textValue = value.toString();
				}
			}
			if (textValue === null || textValue === void 0) return b`(empty)`;
			let markdownText = textValue;
			switch (this.usageHint) {
				case "h1":
					markdownText = `# ${markdownText}`;
					break;
				case "h2":
					markdownText = `## ${markdownText}`;
					break;
				case "h3":
					markdownText = `### ${markdownText}`;
					break;
				case "h4":
					markdownText = `#### ${markdownText}`;
					break;
				case "h5":
					markdownText = `##### ${markdownText}`;
					break;
				case "caption":
					markdownText = `*${markdownText}*`;
					break;
				default: break;
			}
			return b`${markdown(markdownText, appendToAll(this.theme.markdown, [
				"ol",
				"ul",
				"li"
			], {}))}`;
		}
		#areHintedStyles(styles) {
			if (typeof styles !== "object") return false;
			if (Array.isArray(styles)) return false;
			if (!styles) return false;
			return [
				"h1",
				"h2",
				"h3",
				"h4",
				"h5",
				"h6",
				"caption",
				"body"
			].every((v) => v in styles);
		}
		#getAdditionalStyles() {
			let additionalStyles = {};
			const styles = this.theme.additionalStyles?.Text;
			if (!styles) return additionalStyles;
			if (this.#areHintedStyles(styles)) additionalStyles = styles[this.usageHint ?? "body"];
			else additionalStyles = styles;
			return additionalStyles;
		}
		render() {
			return b`<section
      class=${e$2(merge(this.theme.components.Text.all, this.usageHint ? this.theme.components.Text[this.usageHint] : {}))}
      style=${this.theme.additionalStyles?.Text ? o$2(this.#getAdditionalStyles()) : A}
    >
      ${this.#renderText()}
    </section>`;
		}
		constructor() {
			super(...arguments);
			__runInitializers$1(this, _usageHint_extraInitializers);
		}
		static {
			__runInitializers$1(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
(() => {
	let _classDecorators = [t$1("a2ui-video")];
	let _classDescriptor;
	let _classExtraInitializers = [];
	let _classThis;
	let _classSuper = Root;
	let _url_decorators;
	let _url_initializers = [];
	let _url_extraInitializers = [];
	var Video = class extends _classSuper {
		static {
			_classThis = this;
		}
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_url_decorators = [n$6()];
			__esDecorate(this, null, _url_decorators, {
				kind: "accessor",
				name: "url",
				static: false,
				private: false,
				access: {
					has: (obj) => "url" in obj,
					get: (obj) => obj.url,
					set: (obj, value) => {
						obj.url = value;
					}
				},
				metadata: _metadata
			}, _url_initializers, _url_extraInitializers);
			__esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, {
				kind: "class",
				name: _classThis.name,
				metadata: _metadata
			}, null, _classExtraInitializers);
			Video = _classThis = _classDescriptor.value;
			if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		#url_accessor_storage = __runInitializers(this, _url_initializers, null);
		get url() {
			return this.#url_accessor_storage;
		}
		set url(value) {
			this.#url_accessor_storage = value;
		}
		static {
			this.styles = [structuralStyles, i$9`
      * {
        box-sizing: border-box;
      }

      :host {
        display: block;
        flex: var(--weight);
        min-height: 0;
        overflow: auto;
      }

      video {
        display: block;
        width: 100%;
      }
    `];
		}
		#renderVideo() {
			if (!this.url) return A;
			if (this.url && typeof this.url === "object") {
				if ("literalString" in this.url) return b`<video controls src=${this.url.literalString} />`;
				else if ("literal" in this.url) return b`<video controls src=${this.url.literal} />`;
				else if (this.url && "path" in this.url && this.url.path) {
					if (!this.processor || !this.component) return b`(no processor)`;
					const videoUrl = this.processor.getData(this.component, this.url.path, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
					if (!videoUrl) return b`Invalid video URL`;
					if (typeof videoUrl !== "string") return b`Invalid video URL`;
					return b`<video controls src=${videoUrl} />`;
				}
			}
			return b`(empty)`;
		}
		render() {
			return b`<section
      class=${e$2(this.theme.components.Video)}
      style=${this.theme.additionalStyles?.Video ? o$2(this.theme.additionalStyles?.Video) : A}
    >
      ${this.#renderVideo()}
    </section>`;
		}
		constructor() {
			super(...arguments);
			__runInitializers(this, _url_extraInitializers);
		}
		static {
			__runInitializers(_classThis, _classExtraInitializers);
		}
	};
	return _classThis;
})();
const modalStyles = i$9`
  dialog {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 24px;
    border: none;
    background: rgba(5, 8, 16, 0.65);
    backdrop-filter: blur(6px);
    display: grid;
    place-items: center;
  }

  dialog::backdrop {
    background: rgba(5, 8, 16, 0.65);
    backdrop-filter: blur(6px);
  }
`;
const modalElement = customElements.get("a2ui-modal");
if (modalElement && Array.isArray(modalElement.styles)) modalElement.styles = [...modalElement.styles, modalStyles];
const appendComponentStyles = (tagName, extraStyles) => {
	const component = customElements.get(tagName);
	if (!component) return;
	const current = component.styles;
	if (!current) {
		component.styles = [extraStyles];
		return;
	}
	component.styles = Array.isArray(current) ? [...current, extraStyles] : [current, extraStyles];
};
appendComponentStyles("a2ui-row", i$9`
    @media (max-width: 860px) {
      section {
        flex-wrap: wrap;
        align-content: flex-start;
      }

      ::slotted(*) {
        flex: 1 1 100%;
        min-width: 100%;
        width: 100%;
        max-width: 100%;
      }
    }
  `);
appendComponentStyles("a2ui-column", i$9`
    :host {
      min-width: 0;
    }

    section {
      min-width: 0;
    }
  `);
appendComponentStyles("a2ui-card", i$9`
    :host {
      min-width: 0;
    }

    section {
      min-width: 0;
    }
  `);
const emptyClasses = () => ({});
const textHintStyles = () => ({
	h1: {},
	h2: {},
	h3: {},
	h4: {},
	h5: {},
	body: {},
	caption: {}
});
const isAndroid = /Android/i.test(globalThis.navigator?.userAgent ?? "");
const cardShadow = isAndroid ? "0 2px 10px rgba(0,0,0,.18)" : "0 10px 30px rgba(0,0,0,.35)";
const buttonShadow = isAndroid ? "0 2px 10px rgba(6, 182, 212, 0.14)" : "0 10px 25px rgba(6, 182, 212, 0.18)";
const statusShadow = isAndroid ? "0 2px 10px rgba(0, 0, 0, 0.18)" : "0 10px 24px rgba(0, 0, 0, 0.25)";
const statusBlur = isAndroid ? "10px" : "14px";
const openclawTheme = {
	components: {
		AudioPlayer: emptyClasses(),
		Button: emptyClasses(),
		Card: emptyClasses(),
		Column: emptyClasses(),
		CheckBox: {
			container: emptyClasses(),
			element: emptyClasses(),
			label: emptyClasses()
		},
		DateTimeInput: {
			container: emptyClasses(),
			element: emptyClasses(),
			label: emptyClasses()
		},
		Divider: emptyClasses(),
		Image: {
			all: emptyClasses(),
			icon: emptyClasses(),
			avatar: emptyClasses(),
			smallFeature: emptyClasses(),
			mediumFeature: emptyClasses(),
			largeFeature: emptyClasses(),
			header: emptyClasses()
		},
		Icon: emptyClasses(),
		List: emptyClasses(),
		Modal: {
			backdrop: emptyClasses(),
			element: emptyClasses()
		},
		MultipleChoice: {
			container: emptyClasses(),
			element: emptyClasses(),
			label: emptyClasses()
		},
		Row: emptyClasses(),
		Slider: {
			container: emptyClasses(),
			element: emptyClasses(),
			label: emptyClasses()
		},
		Tabs: {
			container: emptyClasses(),
			element: emptyClasses(),
			controls: {
				all: emptyClasses(),
				selected: emptyClasses()
			}
		},
		Text: {
			all: emptyClasses(),
			h1: emptyClasses(),
			h2: emptyClasses(),
			h3: emptyClasses(),
			h4: emptyClasses(),
			h5: emptyClasses(),
			caption: emptyClasses(),
			body: emptyClasses()
		},
		TextField: {
			container: emptyClasses(),
			element: emptyClasses(),
			label: emptyClasses()
		},
		Video: emptyClasses()
	},
	elements: {
		a: emptyClasses(),
		audio: emptyClasses(),
		body: emptyClasses(),
		button: emptyClasses(),
		h1: emptyClasses(),
		h2: emptyClasses(),
		h3: emptyClasses(),
		h4: emptyClasses(),
		h5: emptyClasses(),
		iframe: emptyClasses(),
		input: emptyClasses(),
		p: emptyClasses(),
		pre: emptyClasses(),
		textarea: emptyClasses(),
		video: emptyClasses()
	},
	markdown: {
		p: [],
		h1: [],
		h2: [],
		h3: [],
		h4: [],
		h5: [],
		ul: [],
		ol: [],
		li: [],
		a: [],
		strong: [],
		em: []
	},
	additionalStyles: {
		Card: {
			background: "linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.03))",
			border: "1px solid rgba(255,255,255,.09)",
			borderRadius: "14px",
			padding: "14px",
			boxShadow: cardShadow
		},
		Modal: {
			background: "rgba(12, 16, 24, 0.92)",
			border: "1px solid rgba(255,255,255,.12)",
			borderRadius: "16px",
			padding: "16px",
			boxShadow: "0 30px 80px rgba(0,0,0,.6)",
			width: "min(520px, calc(100vw - 48px))"
		},
		Column: { gap: "10px" },
		Row: {
			gap: "10px",
			alignItems: "center"
		},
		Divider: { opacity: "0.25" },
		Button: {
			background: "linear-gradient(135deg, #22c55e 0%, #06b6d4 100%)",
			border: "0",
			borderRadius: "12px",
			padding: "10px 14px",
			color: "#071016",
			fontWeight: "650",
			cursor: "pointer",
			boxShadow: buttonShadow
		},
		Text: {
			...textHintStyles(),
			h1: {
				fontSize: "20px",
				fontWeight: "750",
				margin: "0 0 6px 0"
			},
			h2: {
				fontSize: "16px",
				fontWeight: "700",
				margin: "0 0 6px 0"
			},
			body: {
				fontSize: "13px",
				lineHeight: "1.4"
			},
			caption: { opacity: "0.8" }
		},
		TextField: {
			display: "grid",
			gap: "6px"
		},
		Image: { borderRadius: "12px" }
	}
};
var OpenClawA2UIHost = class extends i$6 {
	static properties = {
		surfaces: { state: true },
		pendingAction: { state: true },
		toast: { state: true }
	};
	#processor = Data.createSignalA2uiMessageProcessor();
	themeProvider = new i$3(this, {
		context: themeContext,
		initialValue: openclawTheme
	});
	surfaces = [];
	pendingAction = null;
	toast = null;
	#statusListener = null;
	static styles = i$9`
    :host {
      display: block;
      height: 100%;
      position: relative;
      box-sizing: border-box;
      padding:
        var(--openclaw-a2ui-inset-top, 0px)
        var(--openclaw-a2ui-inset-right, 0px)
        var(--openclaw-a2ui-inset-bottom, 0px)
        var(--openclaw-a2ui-inset-left, 0px);
    }

    #surfaces {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
      height: 100%;
      overflow: auto;
      padding-bottom: var(--openclaw-a2ui-scroll-pad-bottom, 0px);
    }

    .status {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      top: var(--openclaw-a2ui-status-top, 12px);
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid rgba(255, 255, 255, 0.18);
      color: rgba(255, 255, 255, 0.92);
      font: 13px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Roboto", sans-serif;
      pointer-events: none;
      backdrop-filter: blur(${r$11(statusBlur)});
      -webkit-backdrop-filter: blur(${r$11(statusBlur)});
      box-shadow: ${r$11(statusShadow)};
      z-index: 5;
    }

    .toast {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      bottom: var(--openclaw-a2ui-toast-bottom, 12px);
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid rgba(255, 255, 255, 0.18);
      color: rgba(255, 255, 255, 0.92);
      font: 13px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Roboto", sans-serif;
      pointer-events: none;
      backdrop-filter: blur(${r$11(statusBlur)});
      -webkit-backdrop-filter: blur(${r$11(statusBlur)});
      box-shadow: ${r$11(statusShadow)};
      z-index: 5;
    }

    .toast.error {
      border-color: rgba(255, 109, 109, 0.35);
      color: rgba(255, 223, 223, 0.98);
    }

    .empty {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      top: var(--openclaw-a2ui-empty-top, var(--openclaw-a2ui-status-top, 12px));
      text-align: center;
      opacity: 0.8;
      padding: 10px 12px;
      pointer-events: none;
    }

    .empty-title {
      font-weight: 700;
      margin-bottom: 6px;
    }

    .spinner {
      width: 12px;
      height: 12px;
      border-radius: 999px;
      border: 2px solid rgba(255, 255, 255, 0.25);
      border-top-color: rgba(255, 255, 255, 0.92);
      animation: spin 0.75s linear infinite;
    }

    @keyframes spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }
  `;
	connectedCallback() {
		super.connectedCallback();
		globalThis.openclawA2UI = {
			applyMessages: (messages) => this.applyMessages(messages),
			reset: () => this.reset(),
			getSurfaces: () => Array.from(this.#processor.getSurfaces().keys())
		};
		this.addEventListener("a2uiaction", (evt) => this.#handleA2UIAction(evt));
		this.#statusListener = (evt) => this.#handleActionStatus(evt);
		for (const eventName of ["openclaw:a2ui-action-status"]) globalThis.addEventListener(eventName, this.#statusListener);
		this.#syncSurfaces();
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		if (this.#statusListener) {
			for (const eventName of ["openclaw:a2ui-action-status"]) globalThis.removeEventListener(eventName, this.#statusListener);
			this.#statusListener = null;
		}
	}
	#makeActionId() {
		return globalThis.crypto?.randomUUID?.() ?? `a2ui_${Date.now()}_${Math.random().toString(16).slice(2)}`;
	}
	#setToast(text, kind = "ok", timeoutMs = 1400) {
		const toast = {
			text,
			kind,
			expiresAt: Date.now() + timeoutMs
		};
		this.toast = toast;
		this.requestUpdate();
		setTimeout(() => {
			if (this.toast === toast) {
				this.toast = null;
				this.requestUpdate();
			}
		}, timeoutMs + 30);
	}
	#handleActionStatus(evt) {
		const detail = evt?.detail ?? null;
		if (!detail || typeof detail.id !== "string") return;
		if (!this.pendingAction || this.pendingAction.id !== detail.id) return;
		if (detail.ok) this.pendingAction = {
			...this.pendingAction,
			phase: "sent",
			sentAt: Date.now()
		};
		else {
			const msg = typeof detail.error === "string" && detail.error ? detail.error : "send failed";
			this.pendingAction = {
				...this.pendingAction,
				phase: "error",
				error: msg
			};
			this.#setToast(`Failed: ${msg}`, "error", 4500);
		}
		this.requestUpdate();
	}
	#handleA2UIAction(evt) {
		const payload = evt?.detail ?? evt?.payload ?? null;
		if (!payload || payload.eventType !== "a2ui.action") return;
		const action = payload.action;
		const name = action?.name;
		if (!name) return;
		const sourceComponentId = payload.sourceComponentId ?? "";
		const surfaces = this.#processor.getSurfaces();
		let surfaceId = null;
		let sourceNode = null;
		for (const [sid, surface] of surfaces.entries()) {
			const node = surface?.components?.get?.(sourceComponentId) ?? null;
			if (node) {
				surfaceId = sid;
				sourceNode = node;
				break;
			}
		}
		const context = {};
		const ctxItems = Array.isArray(action?.context) ? action.context : [];
		for (const item of ctxItems) {
			const key = item?.key;
			const value = item?.value ?? null;
			if (!key || !value) continue;
			if (typeof value.path === "string") {
				context[key] = sourceNode ? this.#processor.getData(sourceNode, value.path, surfaceId ?? void 0) : null;
				continue;
			}
			if (Object.prototype.hasOwnProperty.call(value, "literalString")) {
				context[key] = value.literalString ?? "";
				continue;
			}
			if (Object.prototype.hasOwnProperty.call(value, "literalNumber")) {
				context[key] = value.literalNumber ?? 0;
				continue;
			}
			if (Object.prototype.hasOwnProperty.call(value, "literalBoolean")) {
				context[key] = value.literalBoolean ?? false;
				continue;
			}
		}
		const actionId = this.#makeActionId();
		this.pendingAction = {
			id: actionId,
			name,
			phase: "sending",
			startedAt: Date.now()
		};
		this.requestUpdate();
		const userAction = {
			id: actionId,
			name,
			surfaceId: surfaceId ?? "main",
			sourceComponentId,
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			...Object.keys(context).length ? { context } : {}
		};
		globalThis.__openclawLastA2UIAction = userAction;
		const handler = globalThis.webkit?.messageHandlers?.openclawCanvasA2UIAction ?? globalThis.openclawCanvasA2UIAction;
		if (handler?.postMessage) try {
			if (handler === globalThis.openclawCanvasA2UIAction) handler.postMessage(JSON.stringify({ userAction }));
			else handler.postMessage({ userAction });
		} catch (e) {
			const msg = String(e?.message ?? e);
			this.pendingAction = {
				id: actionId,
				name,
				phase: "error",
				startedAt: Date.now(),
				error: msg
			};
			this.#setToast(`Failed: ${msg}`, "error", 4500);
		}
		else {
			this.pendingAction = {
				id: actionId,
				name,
				phase: "error",
				startedAt: Date.now(),
				error: "missing native bridge"
			};
			this.#setToast("Failed: missing native bridge", "error", 4500);
		}
	}
	applyMessages(messages) {
		if (!Array.isArray(messages)) throw new Error("A2UI: expected messages array");
		this.#processor.processMessages(messages);
		this.#syncSurfaces();
		if (this.pendingAction?.phase === "sent") {
			this.#setToast(`Updated: ${this.pendingAction.name}`, "ok", 1100);
			this.pendingAction = null;
		}
		this.requestUpdate();
		return {
			ok: true,
			surfaces: this.surfaces.map(([id]) => id)
		};
	}
	reset() {
		this.#processor.clearSurfaces();
		this.#syncSurfaces();
		this.pendingAction = null;
		this.requestUpdate();
		return { ok: true };
	}
	#syncSurfaces() {
		this.surfaces = Array.from(this.#processor.getSurfaces().entries());
	}
	render() {
		if (this.surfaces.length === 0) return b`<div class="empty">
        <div class="empty-title">Canvas (A2UI)</div>
      </div>`;
		const statusText = this.pendingAction?.phase === "sent" ? `Working: ${this.pendingAction.name}` : this.pendingAction?.phase === "sending" ? `Sending: ${this.pendingAction.name}` : this.pendingAction?.phase === "error" ? `Failed: ${this.pendingAction.name}` : "";
		return b`
      ${this.pendingAction && this.pendingAction.phase !== "error" ? b`<div class="status"><div class="spinner"></div><div>${statusText}</div></div>` : ""}
      ${this.toast ? b`<div class="toast ${this.toast.kind === "error" ? "error" : ""}">${this.toast.text}</div>` : ""}
      <section id="surfaces">
      ${c$2(this.surfaces, ([surfaceId]) => surfaceId, ([surfaceId, surface]) => b`<a2ui-surface
          .surfaceId=${surfaceId}
          .surface=${surface}
          .processor=${this.#processor}
        ></a2ui-surface>`)}
    </section>`;
	}
};
if (!customElements.get("openclaw-a2ui-host")) customElements.define("openclaw-a2ui-host", OpenClawA2UIHost);
