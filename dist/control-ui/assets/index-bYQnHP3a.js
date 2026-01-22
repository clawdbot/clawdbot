(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const i of document.querySelectorAll('link[rel="modulepreload"]'))s(i);new MutationObserver(i=>{for(const o of i)if(o.type==="childList")for(const a of o.addedNodes)a.tagName==="LINK"&&a.rel==="modulepreload"&&s(a)}).observe(document,{childList:!0,subtree:!0});function n(i){const o={};return i.integrity&&(o.integrity=i.integrity),i.referrerPolicy&&(o.referrerPolicy=i.referrerPolicy),i.crossOrigin==="use-credentials"?o.credentials="include":i.crossOrigin==="anonymous"?o.credentials="omit":o.credentials="same-origin",o}function s(i){if(i.ep)return;i.ep=!0;const o=n(i);fetch(i.href,o)}})();const zt=globalThis,As=zt.ShadowRoot&&(zt.ShadyCSS===void 0||zt.ShadyCSS.nativeShadow)&&"adoptedStyleSheets"in Document.prototype&&"replace"in CSSStyleSheet.prototype,Ss=Symbol(),Li=new WeakMap;let Ho=class{constructor(t,n,s){if(this._$cssResult$=!0,s!==Ss)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=t,this.t=n}get styleSheet(){let t=this.o;const n=this.t;if(As&&t===void 0){const s=n!==void 0&&n.length===1;s&&(t=Li.get(n)),t===void 0&&((this.o=t=new CSSStyleSheet).replaceSync(this.cssText),s&&Li.set(n,t))}return t}toString(){return this.cssText}};const Lr=e=>new Ho(typeof e=="string"?e:e+"",void 0,Ss),Rr=(e,...t)=>{const n=e.length===1?e[0]:t.reduce((s,i,o)=>s+(a=>{if(a._$cssResult$===!0)return a.cssText;if(typeof a=="number")return a;throw Error("Value passed to 'css' function must be a 'css' function result: "+a+". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.")})(i)+e[o+1],e[0]);return new Ho(n,e,Ss)},Mr=(e,t)=>{if(As)e.adoptedStyleSheets=t.map(n=>n instanceof CSSStyleSheet?n:n.styleSheet);else for(const n of t){const s=document.createElement("style"),i=zt.litNonce;i!==void 0&&s.setAttribute("nonce",i),s.textContent=n.cssText,e.appendChild(s)}},Ri=As?e=>e:e=>e instanceof CSSStyleSheet?(t=>{let n="";for(const s of t.cssRules)n+=s.cssText;return Lr(n)})(e):e;const{is:Pr,defineProperty:Nr,getOwnPropertyDescriptor:Or,getOwnPropertyNames:Dr,getOwnPropertySymbols:Br,getPrototypeOf:Fr}=Object,en=globalThis,Mi=en.trustedTypes,Ur=Mi?Mi.emptyScript:"",Kr=en.reactiveElementPolyfillSupport,vt=(e,t)=>e,Wt={toAttribute(e,t){switch(t){case Boolean:e=e?Ur:null;break;case Object:case Array:e=e==null?e:JSON.stringify(e)}return e},fromAttribute(e,t){let n=e;switch(t){case Boolean:n=e!==null;break;case Number:n=e===null?null:Number(e);break;case Object:case Array:try{n=JSON.parse(e)}catch{n=null}}return n}},_s=(e,t)=>!Pr(e,t),Pi={attribute:!0,type:String,converter:Wt,reflect:!1,useDefault:!1,hasChanged:_s};Symbol.metadata??=Symbol("metadata"),en.litPropertyMetadata??=new WeakMap;let Ve=class extends HTMLElement{static addInitializer(t){this._$Ei(),(this.l??=[]).push(t)}static get observedAttributes(){return this.finalize(),this._$Eh&&[...this._$Eh.keys()]}static createProperty(t,n=Pi){if(n.state&&(n.attribute=!1),this._$Ei(),this.prototype.hasOwnProperty(t)&&((n=Object.create(n)).wrapped=!0),this.elementProperties.set(t,n),!n.noAccessor){const s=Symbol(),i=this.getPropertyDescriptor(t,s,n);i!==void 0&&Nr(this.prototype,t,i)}}static getPropertyDescriptor(t,n,s){const{get:i,set:o}=Or(this.prototype,t)??{get(){return this[n]},set(a){this[n]=a}};return{get:i,set(a){const c=i?.call(this);o?.call(this,a),this.requestUpdate(t,c,s)},configurable:!0,enumerable:!0}}static getPropertyOptions(t){return this.elementProperties.get(t)??Pi}static _$Ei(){if(this.hasOwnProperty(vt("elementProperties")))return;const t=Fr(this);t.finalize(),t.l!==void 0&&(this.l=[...t.l]),this.elementProperties=new Map(t.elementProperties)}static finalize(){if(this.hasOwnProperty(vt("finalized")))return;if(this.finalized=!0,this._$Ei(),this.hasOwnProperty(vt("properties"))){const n=this.properties,s=[...Dr(n),...Br(n)];for(const i of s)this.createProperty(i,n[i])}const t=this[Symbol.metadata];if(t!==null){const n=litPropertyMetadata.get(t);if(n!==void 0)for(const[s,i]of n)this.elementProperties.set(s,i)}this._$Eh=new Map;for(const[n,s]of this.elementProperties){const i=this._$Eu(n,s);i!==void 0&&this._$Eh.set(i,n)}this.elementStyles=this.finalizeStyles(this.styles)}static finalizeStyles(t){const n=[];if(Array.isArray(t)){const s=new Set(t.flat(1/0).reverse());for(const i of s)n.unshift(Ri(i))}else t!==void 0&&n.push(Ri(t));return n}static _$Eu(t,n){const s=n.attribute;return s===!1?void 0:typeof s=="string"?s:typeof t=="string"?t.toLowerCase():void 0}constructor(){super(),this._$Ep=void 0,this.isUpdatePending=!1,this.hasUpdated=!1,this._$Em=null,this._$Ev()}_$Ev(){this._$ES=new Promise(t=>this.enableUpdating=t),this._$AL=new Map,this._$E_(),this.requestUpdate(),this.constructor.l?.forEach(t=>t(this))}addController(t){(this._$EO??=new Set).add(t),this.renderRoot!==void 0&&this.isConnected&&t.hostConnected?.()}removeController(t){this._$EO?.delete(t)}_$E_(){const t=new Map,n=this.constructor.elementProperties;for(const s of n.keys())this.hasOwnProperty(s)&&(t.set(s,this[s]),delete this[s]);t.size>0&&(this._$Ep=t)}createRenderRoot(){const t=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return Mr(t,this.constructor.elementStyles),t}connectedCallback(){this.renderRoot??=this.createRenderRoot(),this.enableUpdating(!0),this._$EO?.forEach(t=>t.hostConnected?.())}enableUpdating(t){}disconnectedCallback(){this._$EO?.forEach(t=>t.hostDisconnected?.())}attributeChangedCallback(t,n,s){this._$AK(t,s)}_$ET(t,n){const s=this.constructor.elementProperties.get(t),i=this.constructor._$Eu(t,s);if(i!==void 0&&s.reflect===!0){const o=(s.converter?.toAttribute!==void 0?s.converter:Wt).toAttribute(n,s.type);this._$Em=t,o==null?this.removeAttribute(i):this.setAttribute(i,o),this._$Em=null}}_$AK(t,n){const s=this.constructor,i=s._$Eh.get(t);if(i!==void 0&&this._$Em!==i){const o=s.getPropertyOptions(i),a=typeof o.converter=="function"?{fromAttribute:o.converter}:o.converter?.fromAttribute!==void 0?o.converter:Wt;this._$Em=i;const c=a.fromAttribute(n,o.type);this[i]=c??this._$Ej?.get(i)??c,this._$Em=null}}requestUpdate(t,n,s,i=!1,o){if(t!==void 0){const a=this.constructor;if(i===!1&&(o=this[t]),s??=a.getPropertyOptions(t),!((s.hasChanged??_s)(o,n)||s.useDefault&&s.reflect&&o===this._$Ej?.get(t)&&!this.hasAttribute(a._$Eu(t,s))))return;this.C(t,n,s)}this.isUpdatePending===!1&&(this._$ES=this._$EP())}C(t,n,{useDefault:s,reflect:i,wrapped:o},a){s&&!(this._$Ej??=new Map).has(t)&&(this._$Ej.set(t,a??n??this[t]),o!==!0||a!==void 0)||(this._$AL.has(t)||(this.hasUpdated||s||(n=void 0),this._$AL.set(t,n)),i===!0&&this._$Em!==t&&(this._$Eq??=new Set).add(t))}async _$EP(){this.isUpdatePending=!0;try{await this._$ES}catch(n){Promise.reject(n)}const t=this.scheduleUpdate();return t!=null&&await t,!this.isUpdatePending}scheduleUpdate(){return this.performUpdate()}performUpdate(){if(!this.isUpdatePending)return;if(!this.hasUpdated){if(this.renderRoot??=this.createRenderRoot(),this._$Ep){for(const[i,o]of this._$Ep)this[i]=o;this._$Ep=void 0}const s=this.constructor.elementProperties;if(s.size>0)for(const[i,o]of s){const{wrapped:a}=o,c=this[i];a!==!0||this._$AL.has(i)||c===void 0||this.C(i,void 0,o,c)}}let t=!1;const n=this._$AL;try{t=this.shouldUpdate(n),t?(this.willUpdate(n),this._$EO?.forEach(s=>s.hostUpdate?.()),this.update(n)):this._$EM()}catch(s){throw t=!1,this._$EM(),s}t&&this._$AE(n)}willUpdate(t){}_$AE(t){this._$EO?.forEach(n=>n.hostUpdated?.()),this.hasUpdated||(this.hasUpdated=!0,this.firstUpdated(t)),this.updated(t)}_$EM(){this._$AL=new Map,this.isUpdatePending=!1}get updateComplete(){return this.getUpdateComplete()}getUpdateComplete(){return this._$ES}shouldUpdate(t){return!0}update(t){this._$Eq&&=this._$Eq.forEach(n=>this._$ET(n,this[n])),this._$EM()}updated(t){}firstUpdated(t){}};Ve.elementStyles=[],Ve.shadowRootOptions={mode:"open"},Ve[vt("elementProperties")]=new Map,Ve[vt("finalized")]=new Map,Kr?.({ReactiveElement:Ve}),(en.reactiveElementVersions??=[]).push("2.1.2");const Ts=globalThis,Ni=e=>e,Vt=Ts.trustedTypes,Oi=Vt?Vt.createPolicy("lit-html",{createHTML:e=>e}):void 0,zo="$lit$",we=`lit$${Math.random().toFixed(9).slice(2)}$`,jo="?"+we,Hr=`<${jo}>`,Pe=document,yt=()=>Pe.createComment(""),wt=e=>e===null||typeof e!="object"&&typeof e!="function",Es=Array.isArray,zr=e=>Es(e)||typeof e?.[Symbol.iterator]=="function",Nn=`[ 	
\f\r]`,ot=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,Di=/-->/g,Bi=/>/g,Ce=RegExp(`>|${Nn}(?:([^\\s"'>=/]+)(${Nn}*=${Nn}*(?:[^ 	
\f\r"'\`<>=]|("|')|))|$)`,"g"),Fi=/'/g,Ui=/"/g,qo=/^(?:script|style|textarea|title)$/i,jr=e=>(t,...n)=>({_$litType$:e,strings:t,values:n}),d=jr(1),xe=Symbol.for("lit-noChange"),g=Symbol.for("lit-nothing"),Ki=new WeakMap,Me=Pe.createTreeWalker(Pe,129);function Wo(e,t){if(!Es(e)||!e.hasOwnProperty("raw"))throw Error("invalid template strings array");return Oi!==void 0?Oi.createHTML(t):t}const qr=(e,t)=>{const n=e.length-1,s=[];let i,o=t===2?"<svg>":t===3?"<math>":"",a=ot;for(let c=0;c<n;c++){const r=e[c];let p,l,u=-1,h=0;for(;h<r.length&&(a.lastIndex=h,l=a.exec(r),l!==null);)h=a.lastIndex,a===ot?l[1]==="!--"?a=Di:l[1]!==void 0?a=Bi:l[2]!==void 0?(qo.test(l[2])&&(i=RegExp("</"+l[2],"g")),a=Ce):l[3]!==void 0&&(a=Ce):a===Ce?l[0]===">"?(a=i??ot,u=-1):l[1]===void 0?u=-2:(u=a.lastIndex-l[2].length,p=l[1],a=l[3]===void 0?Ce:l[3]==='"'?Ui:Fi):a===Ui||a===Fi?a=Ce:a===Di||a===Bi?a=ot:(a=Ce,i=void 0);const v=a===Ce&&e[c+1].startsWith("/>")?" ":"";o+=a===ot?r+Hr:u>=0?(s.push(p),r.slice(0,u)+zo+r.slice(u)+we+v):r+we+(u===-2?c:v)}return[Wo(e,o+(e[n]||"<?>")+(t===2?"</svg>":t===3?"</math>":"")),s]};let Xn=class Vo{constructor({strings:t,_$litType$:n},s){let i;this.parts=[];let o=0,a=0;const c=t.length-1,r=this.parts,[p,l]=qr(t,n);if(this.el=Vo.createElement(p,s),Me.currentNode=this.el.content,n===2||n===3){const u=this.el.content.firstChild;u.replaceWith(...u.childNodes)}for(;(i=Me.nextNode())!==null&&r.length<c;){if(i.nodeType===1){if(i.hasAttributes())for(const u of i.getAttributeNames())if(u.endsWith(zo)){const h=l[a++],v=i.getAttribute(u).split(we),w=/([.?@])?(.*)/.exec(h);r.push({type:1,index:o,name:w[2],strings:v,ctor:w[1]==="."?Vr:w[1]==="?"?Gr:w[1]==="@"?Yr:nn}),i.removeAttribute(u)}else u.startsWith(we)&&(r.push({type:6,index:o}),i.removeAttribute(u));if(qo.test(i.tagName)){const u=i.textContent.split(we),h=u.length-1;if(h>0){i.textContent=Vt?Vt.emptyScript:"";for(let v=0;v<h;v++)i.append(u[v],yt()),Me.nextNode(),r.push({type:2,index:++o});i.append(u[h],yt())}}}else if(i.nodeType===8)if(i.data===jo)r.push({type:2,index:o});else{let u=-1;for(;(u=i.data.indexOf(we,u+1))!==-1;)r.push({type:7,index:o}),u+=we.length-1}o++}}static createElement(t,n){const s=Pe.createElement("template");return s.innerHTML=t,s}};function Qe(e,t,n=e,s){if(t===xe)return t;let i=s!==void 0?n._$Co?.[s]:n._$Cl;const o=wt(t)?void 0:t._$litDirective$;return i?.constructor!==o&&(i?._$AO?.(!1),o===void 0?i=void 0:(i=new o(e),i._$AT(e,n,s)),s!==void 0?(n._$Co??=[])[s]=i:n._$Cl=i),i!==void 0&&(t=Qe(e,i._$AS(e,t.values),i,s)),t}class Wr{constructor(t,n){this._$AV=[],this._$AN=void 0,this._$AD=t,this._$AM=n}get parentNode(){return this._$AM.parentNode}get _$AU(){return this._$AM._$AU}u(t){const{el:{content:n},parts:s}=this._$AD,i=(t?.creationScope??Pe).importNode(n,!0);Me.currentNode=i;let o=Me.nextNode(),a=0,c=0,r=s[0];for(;r!==void 0;){if(a===r.index){let p;r.type===2?p=new tn(o,o.nextSibling,this,t):r.type===1?p=new r.ctor(o,r.name,r.strings,this,t):r.type===6&&(p=new Qr(o,this,t)),this._$AV.push(p),r=s[++c]}a!==r?.index&&(o=Me.nextNode(),a++)}return Me.currentNode=Pe,i}p(t){let n=0;for(const s of this._$AV)s!==void 0&&(s.strings!==void 0?(s._$AI(t,s,n),n+=s.strings.length-2):s._$AI(t[n])),n++}}let tn=class Go{get _$AU(){return this._$AM?._$AU??this._$Cv}constructor(t,n,s,i){this.type=2,this._$AH=g,this._$AN=void 0,this._$AA=t,this._$AB=n,this._$AM=s,this.options=i,this._$Cv=i?.isConnected??!0}get parentNode(){let t=this._$AA.parentNode;const n=this._$AM;return n!==void 0&&t?.nodeType===11&&(t=n.parentNode),t}get startNode(){return this._$AA}get endNode(){return this._$AB}_$AI(t,n=this){t=Qe(this,t,n),wt(t)?t===g||t==null||t===""?(this._$AH!==g&&this._$AR(),this._$AH=g):t!==this._$AH&&t!==xe&&this._(t):t._$litType$!==void 0?this.$(t):t.nodeType!==void 0?this.T(t):zr(t)?this.k(t):this._(t)}O(t){return this._$AA.parentNode.insertBefore(t,this._$AB)}T(t){this._$AH!==t&&(this._$AR(),this._$AH=this.O(t))}_(t){this._$AH!==g&&wt(this._$AH)?this._$AA.nextSibling.data=t:this.T(Pe.createTextNode(t)),this._$AH=t}$(t){const{values:n,_$litType$:s}=t,i=typeof s=="number"?this._$AC(t):(s.el===void 0&&(s.el=Xn.createElement(Wo(s.h,s.h[0]),this.options)),s);if(this._$AH?._$AD===i)this._$AH.p(n);else{const o=new Wr(i,this),a=o.u(this.options);o.p(n),this.T(a),this._$AH=o}}_$AC(t){let n=Ki.get(t.strings);return n===void 0&&Ki.set(t.strings,n=new Xn(t)),n}k(t){Es(this._$AH)||(this._$AH=[],this._$AR());const n=this._$AH;let s,i=0;for(const o of t)i===n.length?n.push(s=new Go(this.O(yt()),this.O(yt()),this,this.options)):s=n[i],s._$AI(o),i++;i<n.length&&(this._$AR(s&&s._$AB.nextSibling,i),n.length=i)}_$AR(t=this._$AA.nextSibling,n){for(this._$AP?.(!1,!0,n);t!==this._$AB;){const s=Ni(t).nextSibling;Ni(t).remove(),t=s}}setConnected(t){this._$AM===void 0&&(this._$Cv=t,this._$AP?.(t))}};class nn{get tagName(){return this.element.tagName}get _$AU(){return this._$AM._$AU}constructor(t,n,s,i,o){this.type=1,this._$AH=g,this._$AN=void 0,this.element=t,this.name=n,this._$AM=i,this.options=o,s.length>2||s[0]!==""||s[1]!==""?(this._$AH=Array(s.length-1).fill(new String),this.strings=s):this._$AH=g}_$AI(t,n=this,s,i){const o=this.strings;let a=!1;if(o===void 0)t=Qe(this,t,n,0),a=!wt(t)||t!==this._$AH&&t!==xe,a&&(this._$AH=t);else{const c=t;let r,p;for(t=o[0],r=0;r<o.length-1;r++)p=Qe(this,c[s+r],n,r),p===xe&&(p=this._$AH[r]),a||=!wt(p)||p!==this._$AH[r],p===g?t=g:t!==g&&(t+=(p??"")+o[r+1]),this._$AH[r]=p}a&&!i&&this.j(t)}j(t){t===g?this.element.removeAttribute(this.name):this.element.setAttribute(this.name,t??"")}}let Vr=class extends nn{constructor(){super(...arguments),this.type=3}j(t){this.element[this.name]=t===g?void 0:t}},Gr=class extends nn{constructor(){super(...arguments),this.type=4}j(t){this.element.toggleAttribute(this.name,!!t&&t!==g)}},Yr=class extends nn{constructor(t,n,s,i,o){super(t,n,s,i,o),this.type=5}_$AI(t,n=this){if((t=Qe(this,t,n,0)??g)===xe)return;const s=this._$AH,i=t===g&&s!==g||t.capture!==s.capture||t.once!==s.once||t.passive!==s.passive,o=t!==g&&(s===g||i);i&&this.element.removeEventListener(this.name,this,s),o&&this.element.addEventListener(this.name,this,t),this._$AH=t}handleEvent(t){typeof this._$AH=="function"?this._$AH.call(this.options?.host??this.element,t):this._$AH.handleEvent(t)}},Qr=class{constructor(t,n,s){this.element=t,this.type=6,this._$AN=void 0,this._$AM=n,this.options=s}get _$AU(){return this._$AM._$AU}_$AI(t){Qe(this,t)}};const Jr={I:tn},Zr=Ts.litHtmlPolyfillSupport;Zr?.(Xn,tn),(Ts.litHtmlVersions??=[]).push("3.3.2");const Xr=(e,t,n)=>{const s=n?.renderBefore??t;let i=s._$litPart$;if(i===void 0){const o=n?.renderBefore??null;s._$litPart$=i=new tn(t.insertBefore(yt(),o),o,void 0,n??{})}return i._$AI(e),i};const Cs=globalThis;let Ye=class extends Ve{constructor(){super(...arguments),this.renderOptions={host:this},this._$Do=void 0}createRenderRoot(){const t=super.createRenderRoot();return this.renderOptions.renderBefore??=t.firstChild,t}update(t){const n=this.render();this.hasUpdated||(this.renderOptions.isConnected=this.isConnected),super.update(t),this._$Do=Xr(n,this.renderRoot,this.renderOptions)}connectedCallback(){super.connectedCallback(),this._$Do?.setConnected(!0)}disconnectedCallback(){super.disconnectedCallback(),this._$Do?.setConnected(!1)}render(){return xe}};Ye._$litElement$=!0,Ye.finalized=!0,Cs.litElementHydrateSupport?.({LitElement:Ye});const el=Cs.litElementPolyfillSupport;el?.({LitElement:Ye});(Cs.litElementVersions??=[]).push("4.2.2");const Yo=e=>(t,n)=>{n!==void 0?n.addInitializer(()=>{customElements.define(e,t)}):customElements.define(e,t)};const tl={attribute:!0,type:String,converter:Wt,reflect:!1,hasChanged:_s},nl=(e=tl,t,n)=>{const{kind:s,metadata:i}=n;let o=globalThis.litPropertyMetadata.get(i);if(o===void 0&&globalThis.litPropertyMetadata.set(i,o=new Map),s==="setter"&&((e=Object.create(e)).wrapped=!0),o.set(n.name,e),s==="accessor"){const{name:a}=n;return{set(c){const r=t.get.call(this);t.set.call(this,c),this.requestUpdate(a,r,e,!0,c)},init(c){return c!==void 0&&this.C(a,void 0,e,c),c}}}if(s==="setter"){const{name:a}=n;return function(c){const r=this[a];t.call(this,c),this.requestUpdate(a,r,e,!0,c)}}throw Error("Unsupported decorator location: "+s)};function sn(e){return(t,n)=>typeof n=="object"?nl(e,t,n):((s,i,o)=>{const a=i.hasOwnProperty(o);return i.constructor.createProperty(o,s),a?Object.getOwnPropertyDescriptor(i,o):void 0})(e,t,n)}function y(e){return sn({...e,state:!0,attribute:!1})}const sl=50,il=200,ol="Assistant";function Hi(e,t){if(typeof e!="string")return;const n=e.trim();if(n)return n.length<=t?n:n.slice(0,t)}function es(e){const t=Hi(e?.name,sl)??ol,n=Hi(e?.avatar??void 0,il)??null;return{agentId:typeof e?.agentId=="string"&&e.agentId.trim()?e.agentId.trim():null,name:t,avatar:n}}function al(){return es(typeof window>"u"?{}:{name:window.__CLAWDBOT_ASSISTANT_NAME__,avatar:window.__CLAWDBOT_ASSISTANT_AVATAR__})}const Qo="clawdbot.control.settings.v1";function rl(){const t={gatewayUrl:`${location.protocol==="https:"?"wss":"ws"}://${location.host}`,token:"",sessionKey:"main",lastActiveSessionKey:"main",theme:"system",chatFocusMode:!1,chatShowThinking:!0,splitRatio:.6,navCollapsed:!1,navGroupsCollapsed:{}};try{const n=localStorage.getItem(Qo);if(!n)return t;const s=JSON.parse(n);return{gatewayUrl:typeof s.gatewayUrl=="string"&&s.gatewayUrl.trim()?s.gatewayUrl.trim():t.gatewayUrl,token:typeof s.token=="string"?s.token:t.token,sessionKey:typeof s.sessionKey=="string"&&s.sessionKey.trim()?s.sessionKey.trim():t.sessionKey,lastActiveSessionKey:typeof s.lastActiveSessionKey=="string"&&s.lastActiveSessionKey.trim()?s.lastActiveSessionKey.trim():typeof s.sessionKey=="string"&&s.sessionKey.trim()||t.lastActiveSessionKey,theme:s.theme==="light"||s.theme==="dark"||s.theme==="system"?s.theme:t.theme,chatFocusMode:typeof s.chatFocusMode=="boolean"?s.chatFocusMode:t.chatFocusMode,chatShowThinking:typeof s.chatShowThinking=="boolean"?s.chatShowThinking:t.chatShowThinking,splitRatio:typeof s.splitRatio=="number"&&s.splitRatio>=.4&&s.splitRatio<=.7?s.splitRatio:t.splitRatio,navCollapsed:typeof s.navCollapsed=="boolean"?s.navCollapsed:t.navCollapsed,navGroupsCollapsed:typeof s.navGroupsCollapsed=="object"&&s.navGroupsCollapsed!==null?s.navGroupsCollapsed:t.navGroupsCollapsed}}catch{return t}}function ll(e){localStorage.setItem(Qo,JSON.stringify(e))}function Jo(e){const t=(e??"").trim();if(!t)return null;const n=t.split(":").filter(Boolean);if(n.length<3||n[0]!=="agent")return null;const s=n[1]?.trim(),i=n.slice(2).join(":");return!s||!i?null:{agentId:s,rest:i}}const cl=[{label:"Chat",tabs:["chat"]},{label:"Control",tabs:["overview","channels","instances","sessions","cron"]},{label:"Agent",tabs:["skills","nodes"]},{label:"Settings",tabs:["config","debug","logs"]}],Zo={overview:"/overview",channels:"/channels",instances:"/instances",sessions:"/sessions",cron:"/cron",skills:"/skills",nodes:"/nodes",chat:"/chat",config:"/config",debug:"/debug",logs:"/logs"},Xo=new Map(Object.entries(Zo).map(([e,t])=>[t,e]));function on(e){if(!e)return"";let t=e.trim();return t.startsWith("/")||(t=`/${t}`),t==="/"?"":(t.endsWith("/")&&(t=t.slice(0,-1)),t)}function $t(e){if(!e)return"/";let t=e.trim();return t.startsWith("/")||(t=`/${t}`),t.length>1&&t.endsWith("/")&&(t=t.slice(0,-1)),t}function Is(e,t=""){const n=on(t),s=Zo[e];return n?`${n}${s}`:s}function ea(e,t=""){const n=on(t);let s=e||"/";n&&(s===n?s="/":s.startsWith(`${n}/`)&&(s=s.slice(n.length)));let i=$t(s).toLowerCase();return i.endsWith("/index.html")&&(i="/"),i==="/"?"chat":Xo.get(i)??null}function dl(e){let t=$t(e);if(t.endsWith("/index.html")&&(t=$t(t.slice(0,-11))),t==="/")return"";const n=t.split("/").filter(Boolean);if(n.length===0)return"";for(let s=0;s<n.length;s++){const i=`/${n.slice(s).join("/")}`.toLowerCase();if(Xo.has(i)){const o=n.slice(0,s);return o.length?`/${o.join("/")}`:""}}return`/${n.join("/")}`}function ul(e){switch(e){case"chat":return"💬";case"overview":return"📊";case"channels":return"🔗";case"instances":return"📡";case"sessions":return"📄";case"cron":return"⏰";case"skills":return"⚡️";case"nodes":return"🖥️";case"config":return"⚙️";case"debug":return"🐞";case"logs":return"🧾";default:return"📁"}}function ts(e){switch(e){case"overview":return"Overview";case"channels":return"Channels";case"instances":return"Instances";case"sessions":return"Sessions";case"cron":return"Cron Jobs";case"skills":return"Skills";case"nodes":return"Nodes";case"chat":return"Chat";case"config":return"Config";case"debug":return"Debug";case"logs":return"Logs";default:return"Control"}}function pl(e){switch(e){case"overview":return"Gateway status, entry points, and a fast health read.";case"channels":return"Manage channels and settings.";case"instances":return"Presence beacons from connected clients and nodes.";case"sessions":return"Inspect active sessions and adjust per-session defaults.";case"cron":return"Schedule wakeups and recurring agent runs.";case"skills":return"Manage skill availability and API key injection.";case"nodes":return"Paired devices, capabilities, and command exposure.";case"chat":return"Direct gateway chat session for quick interventions.";case"config":return"Edit ~/.clawdbot/clawdbot.json safely.";case"debug":return"Gateway snapshots, events, and manual RPC calls.";case"logs":return"Live tail of the gateway file logs.";default:return""}}function kt(e){return!e&&e!==0?"n/a":new Date(e).toLocaleString()}function O(e){if(!e&&e!==0)return"n/a";const t=Date.now()-e;if(t<0)return"just now";const n=Math.round(t/1e3);if(n<60)return`${n}s ago`;const s=Math.round(n/60);if(s<60)return`${s}m ago`;const i=Math.round(s/60);return i<48?`${i}h ago`:`${Math.round(i/24)}d ago`}function ta(e){if(!e&&e!==0)return"n/a";if(e<1e3)return`${e}ms`;const t=Math.round(e/1e3);if(t<60)return`${t}s`;const n=Math.round(t/60);if(n<60)return`${n}m`;const s=Math.round(n/60);return s<48?`${s}h`:`${Math.round(s/24)}d`}function ns(e){return!e||e.length===0?"none":e.filter(t=>!!(t&&t.trim())).join(", ")}function ss(e,t=120){return e.length<=t?e:`${e.slice(0,Math.max(0,t-1))}…`}function na(e,t){return e.length<=t?{text:e,truncated:!1,total:e.length}:{text:e.slice(0,Math.max(0,t)),truncated:!0,total:e.length}}function Gt(e,t){const n=Number(e);return Number.isFinite(n)?n:t}const On=/<\s*\/?\s*think(?:ing)?\s*>/gi,zi=/<\s*think(?:ing)?\s*>/i,ji=/<\s*\/\s*think(?:ing)?\s*>/i;function Dn(e){if(!e)return e;const t=zi.test(e),n=ji.test(e);if(!t&&!n)return e;if(t!==n)return t?e.replace(zi,"").trimStart():e.replace(ji,"").trimStart();if(!On.test(e))return e;On.lastIndex=0;let s="",i=0,o=!1;for(const a of e.matchAll(On)){const c=a.index??0;o||(s+=e.slice(i,c)),o=!a[0].toLowerCase().includes("/"),i=c+a[0].length}return o||(s+=e.slice(i)),s.trimStart()}const fl=/^\[([^\]]+)\]\s*/,hl=["WebChat","WhatsApp","Telegram","Signal","Slack","Discord","iMessage","Teams","Matrix","Zalo","Zalo Personal","BlueBubbles"];function gl(e){return/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\b/.test(e)||/\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/.test(e)?!0:hl.some(t=>e.startsWith(`${t} `))}function Bn(e){const t=e.match(fl);if(!t)return e;const n=t[1]??"";return gl(n)?e.slice(t[0].length):e}function an(e){const t=e,n=typeof t.role=="string"?t.role:"",s=t.content;if(typeof s=="string")return n==="assistant"?Dn(s):Bn(s);if(Array.isArray(s)){const i=s.map(o=>{const a=o;return a.type==="text"&&typeof a.text=="string"?a.text:null}).filter(o=>typeof o=="string");if(i.length>0){const o=i.join(`
`);return n==="assistant"?Dn(o):Bn(o)}}return typeof t.text=="string"?n==="assistant"?Dn(t.text):Bn(t.text):null}function vl(e){const n=e.content,s=[];if(Array.isArray(n))for(const c of n){const r=c;if(r.type==="thinking"&&typeof r.thinking=="string"){const p=r.thinking.trim();p&&s.push(p)}}if(s.length>0)return s.join(`
`);const i=ml(e);if(!i)return null;const a=[...i.matchAll(/<\s*think(?:ing)?\s*>([\s\S]*?)<\s*\/\s*think(?:ing)?\s*>/gi)].map(c=>(c[1]??"").trim()).filter(Boolean);return a.length>0?a.join(`
`):null}function ml(e){const t=e,n=t.content;if(typeof n=="string")return n;if(Array.isArray(n)){const s=n.map(i=>{const o=i;return o.type==="text"&&typeof o.text=="string"?o.text:null}).filter(i=>typeof i=="string");if(s.length>0)return s.join(`
`)}return typeof t.text=="string"?t.text:null}function bl(e){const t=e.trim();if(!t)return"";const n=t.split(/\r?\n/).map(s=>s.trim()).filter(Boolean).map(s=>`_${s}_`);return n.length?["_Reasoning:_",...n].join(`
`):""}function qi(e){e[6]=e[6]&15|64,e[8]=e[8]&63|128;let t="";for(let n=0;n<e.length;n++)t+=e[n].toString(16).padStart(2,"0");return`${t.slice(0,8)}-${t.slice(8,12)}-${t.slice(12,16)}-${t.slice(16,20)}-${t.slice(20)}`}function yl(){const e=new Uint8Array(16),t=Date.now();for(let n=0;n<e.length;n++)e[n]=Math.floor(Math.random()*256);return e[0]^=t&255,e[1]^=t>>>8&255,e[2]^=t>>>16&255,e[3]^=t>>>24&255,e}function Ls(e=globalThis.crypto){if(e&&typeof e.randomUUID=="function")return e.randomUUID();if(e&&typeof e.getRandomValues=="function"){const t=new Uint8Array(16);return e.getRandomValues(t),qi(t)}return qi(yl())}async function Je(e){if(!(!e.client||!e.connected)){e.chatLoading=!0,e.lastError=null;try{const t=await e.client.request("chat.history",{sessionKey:e.sessionKey,limit:200});e.chatMessages=Array.isArray(t.messages)?t.messages:[],e.chatThinkingLevel=t.thinkingLevel??null}catch(t){e.lastError=String(t)}finally{e.chatLoading=!1}}}async function wl(e,t){if(!e.client||!e.connected)return!1;const n=t.trim();if(!n)return!1;const s=Date.now();e.chatMessages=[...e.chatMessages,{role:"user",content:[{type:"text",text:n}],timestamp:s}],e.chatSending=!0,e.lastError=null;const i=Ls();e.chatRunId=i,e.chatStream="",e.chatStreamStartedAt=s;try{return await e.client.request("chat.send",{sessionKey:e.sessionKey,message:n,deliver:!1,idempotencyKey:i}),!0}catch(o){const a=String(o);return e.chatRunId=null,e.chatStream=null,e.chatStreamStartedAt=null,e.lastError=a,e.chatMessages=[...e.chatMessages,{role:"assistant",content:[{type:"text",text:"Error: "+a}],timestamp:Date.now()}],!1}finally{e.chatSending=!1}}async function $l(e){if(!e.client||!e.connected)return!1;const t=e.chatRunId;try{return await e.client.request("chat.abort",t?{sessionKey:e.sessionKey,runId:t}:{sessionKey:e.sessionKey}),!0}catch(n){return e.lastError=String(n),!1}}function kl(e,t){if(!t||t.sessionKey!==e.sessionKey||t.runId&&e.chatRunId&&t.runId!==e.chatRunId)return null;if(t.state==="delta"){const n=an(t.message);if(typeof n=="string"){const s=e.chatStream??"";(!s||n.length>=s.length)&&(e.chatStream=n)}}else t.state==="final"||t.state==="aborted"?(e.chatStream=null,e.chatRunId=null,e.chatStreamStartedAt=null):t.state==="error"&&(e.chatStream=null,e.chatRunId=null,e.chatStreamStartedAt=null,e.lastError=t.errorMessage??"chat error");return t.state}async function tt(e){if(!(!e.client||!e.connected)&&!e.sessionsLoading){e.sessionsLoading=!0,e.sessionsError=null;try{const t={includeGlobal:e.sessionsIncludeGlobal,includeUnknown:e.sessionsIncludeUnknown},n=Gt(e.sessionsFilterActive,0),s=Gt(e.sessionsFilterLimit,0);n>0&&(t.activeMinutes=n),s>0&&(t.limit=s);const i=await e.client.request("sessions.list",t);i&&(e.sessionsResult=i)}catch(t){e.sessionsError=String(t)}finally{e.sessionsLoading=!1}}}async function xl(e,t,n){if(!e.client||!e.connected)return;const s={key:t};"label"in n&&(s.label=n.label),"thinkingLevel"in n&&(s.thinkingLevel=n.thinkingLevel),"verboseLevel"in n&&(s.verboseLevel=n.verboseLevel),"reasoningLevel"in n&&(s.reasoningLevel=n.reasoningLevel);try{await e.client.request("sessions.patch",s),await tt(e)}catch(i){e.sessionsError=String(i)}}async function Al(e,t){if(!(!e.client||!e.connected||e.sessionsLoading||!window.confirm(`Delete session "${t}"?

Deletes the session entry and archives its transcript.`))){e.sessionsLoading=!0,e.sessionsError=null;try{await e.client.request("sessions.delete",{key:t,deleteTranscript:!0}),await tt(e)}catch(s){e.sessionsError=String(s)}finally{e.sessionsLoading=!1}}}const Wi=50,Sl=80,_l=12e4;function Tl(e){if(!e||typeof e!="object")return null;const t=e;if(typeof t.text=="string")return t.text;const n=t.content;if(!Array.isArray(n))return null;const s=n.map(i=>{if(!i||typeof i!="object")return null;const o=i;return o.type==="text"&&typeof o.text=="string"?o.text:null}).filter(i=>!!i);return s.length===0?null:s.join(`
`)}function Vi(e){if(e==null)return null;if(typeof e=="number"||typeof e=="boolean")return String(e);const t=Tl(e);let n;if(typeof e=="string")n=e;else if(t)n=t;else try{n=JSON.stringify(e,null,2)}catch{n=String(e)}const s=na(n,_l);return s.truncated?`${s.text}

… truncated (${s.total} chars, showing first ${s.text.length}).`:s.text}function El(e){const t=[];return t.push({type:"toolcall",name:e.name,arguments:e.args??{}}),e.output&&t.push({type:"toolresult",name:e.name,text:e.output}),{role:"assistant",toolCallId:e.toolCallId,runId:e.runId,content:t,timestamp:e.startedAt}}function Cl(e){if(e.toolStreamOrder.length<=Wi)return;const t=e.toolStreamOrder.length-Wi,n=e.toolStreamOrder.splice(0,t);for(const s of n)e.toolStreamById.delete(s)}function Il(e){e.chatToolMessages=e.toolStreamOrder.map(t=>e.toolStreamById.get(t)?.message).filter(t=>!!t)}function is(e){e.toolStreamSyncTimer!=null&&(clearTimeout(e.toolStreamSyncTimer),e.toolStreamSyncTimer=null),Il(e)}function Ll(e,t=!1){if(t){is(e);return}e.toolStreamSyncTimer==null&&(e.toolStreamSyncTimer=window.setTimeout(()=>is(e),Sl))}function Rs(e){e.toolStreamById.clear(),e.toolStreamOrder=[],e.chatToolMessages=[],is(e)}function Rl(e,t){if(!t||t.stream!=="tool")return;const n=typeof t.sessionKey=="string"?t.sessionKey:void 0;if(n&&n!==e.sessionKey||!n&&e.chatRunId&&t.runId!==e.chatRunId||e.chatRunId&&t.runId!==e.chatRunId||!e.chatRunId)return;const s=t.data??{},i=typeof s.toolCallId=="string"?s.toolCallId:"";if(!i)return;const o=typeof s.name=="string"?s.name:"tool",a=typeof s.phase=="string"?s.phase:"",c=a==="start"?s.args:void 0,r=a==="update"?Vi(s.partialResult):a==="result"?Vi(s.result):void 0,p=Date.now();let l=e.toolStreamById.get(i);l?(l.name=o,c!==void 0&&(l.args=c),r!==void 0&&(l.output=r),l.updatedAt=p):(l={toolCallId:i,runId:t.runId,sessionKey:n,name:o,args:c,output:r,startedAt:typeof t.ts=="number"?t.ts:p,updatedAt:p,message:{}},e.toolStreamById.set(i,l),e.toolStreamOrder.push(i)),l.message=El(l),Cl(e),Ll(e,a==="result")}function rn(e,t=!1){e.chatScrollFrame&&cancelAnimationFrame(e.chatScrollFrame),e.chatScrollTimeout!=null&&(clearTimeout(e.chatScrollTimeout),e.chatScrollTimeout=null);const n=()=>{const s=e.querySelector(".chat-thread");if(s){const i=getComputedStyle(s).overflowY;if(i==="auto"||i==="scroll"||s.scrollHeight-s.clientHeight>1)return s}return document.scrollingElement??document.documentElement};e.updateComplete.then(()=>{e.chatScrollFrame=requestAnimationFrame(()=>{e.chatScrollFrame=null;const s=n();if(!s)return;const i=s.scrollHeight-s.scrollTop-s.clientHeight;if(!(t||e.chatUserNearBottom||i<200))return;t&&(e.chatHasAutoScrolled=!0),s.scrollTop=s.scrollHeight,e.chatUserNearBottom=!0;const a=t?150:120;e.chatScrollTimeout=window.setTimeout(()=>{e.chatScrollTimeout=null;const c=n();if(!c)return;const r=c.scrollHeight-c.scrollTop-c.clientHeight;(t||e.chatUserNearBottom||r<200)&&(c.scrollTop=c.scrollHeight,e.chatUserNearBottom=!0)},a)})})}function sa(e,t=!1){e.logsScrollFrame&&cancelAnimationFrame(e.logsScrollFrame),e.updateComplete.then(()=>{e.logsScrollFrame=requestAnimationFrame(()=>{e.logsScrollFrame=null;const n=e.querySelector(".log-stream");if(!n)return;const s=n.scrollHeight-n.scrollTop-n.clientHeight;(t||s<80)&&(n.scrollTop=n.scrollHeight)})})}function Ml(e,t){const n=t.currentTarget;if(!n)return;const s=n.scrollHeight-n.scrollTop-n.clientHeight;e.chatUserNearBottom=s<200}function Pl(e,t){const n=t.currentTarget;if(!n)return;const s=n.scrollHeight-n.scrollTop-n.clientHeight;e.logsAtBottom=s<80}function Nl(e){e.chatHasAutoScrolled=!1,e.chatUserNearBottom=!0}function Ol(e,t){if(e.length===0)return;const n=new Blob([`${e.join(`
`)}
`],{type:"text/plain"}),s=URL.createObjectURL(n),i=document.createElement("a"),o=new Date().toISOString().slice(0,19).replace(/[:T]/g,"-");i.href=s,i.download=`clawdbot-logs-${t}-${o}.log`,i.click(),URL.revokeObjectURL(s)}function Dl(e){if(typeof ResizeObserver>"u")return;const t=e.querySelector(".topbar");if(!t)return;const n=()=>{const{height:s}=t.getBoundingClientRect();e.style.setProperty("--topbar-height",`${s}px`)};n(),e.topbarObserver=new ResizeObserver(()=>n()),e.topbarObserver.observe(t)}function Ne(e){return typeof structuredClone=="function"?structuredClone(e):JSON.parse(JSON.stringify(e))}function Ze(e){return`${JSON.stringify(e,null,2).trimEnd()}
`}function ia(e,t,n){if(t.length===0)return;let s=e;for(let o=0;o<t.length-1;o+=1){const a=t[o],c=t[o+1];if(typeof a=="number"){if(!Array.isArray(s))return;s[a]==null&&(s[a]=typeof c=="number"?[]:{}),s=s[a]}else{if(typeof s!="object"||s==null)return;const r=s;r[a]==null&&(r[a]=typeof c=="number"?[]:{}),s=r[a]}}const i=t[t.length-1];if(typeof i=="number"){Array.isArray(s)&&(s[i]=n);return}typeof s=="object"&&s!=null&&(s[i]=n)}function oa(e,t){if(t.length===0)return;let n=e;for(let i=0;i<t.length-1;i+=1){const o=t[i];if(typeof o=="number"){if(!Array.isArray(n))return;n=n[o]}else{if(typeof n!="object"||n==null)return;n=n[o]}if(n==null)return}const s=t[t.length-1];if(typeof s=="number"){Array.isArray(n)&&n.splice(s,1);return}typeof n=="object"&&n!=null&&delete n[s]}async function me(e){if(!(!e.client||!e.connected)){e.configLoading=!0,e.lastError=null;try{const t=await e.client.request("config.get",{});Fl(e,t)}catch(t){e.lastError=String(t)}finally{e.configLoading=!1}}}async function aa(e){if(!(!e.client||!e.connected)&&!e.configSchemaLoading){e.configSchemaLoading=!0;try{const t=await e.client.request("config.schema",{});Bl(e,t)}catch(t){e.lastError=String(t)}finally{e.configSchemaLoading=!1}}}function Bl(e,t){e.configSchema=t.schema??null,e.configUiHints=t.uiHints??{},e.configSchemaVersion=t.version??null}function Fl(e,t){e.configSnapshot=t;const n=typeof t.raw=="string"?t.raw:t.config&&typeof t.config=="object"?Ze(t.config):e.configRaw;!e.configFormDirty||e.configFormMode==="raw"?e.configRaw=n:e.configForm?e.configRaw=Ze(e.configForm):e.configRaw=n,e.configValid=typeof t.valid=="boolean"?t.valid:null,e.configIssues=Array.isArray(t.issues)?t.issues:[],e.configFormDirty||(e.configForm=Ne(t.config??{}),e.configFormOriginal=Ne(t.config??{}))}async function os(e){if(!(!e.client||!e.connected)){e.configSaving=!0,e.lastError=null;try{const t=e.configFormMode==="form"&&e.configForm?Ze(e.configForm):e.configRaw,n=e.configSnapshot?.hash;if(!n){e.lastError="Config hash missing; reload and retry.";return}await e.client.request("config.set",{raw:t,baseHash:n}),e.configFormDirty=!1,await me(e)}catch(t){e.lastError=String(t)}finally{e.configSaving=!1}}}async function Ul(e){if(!(!e.client||!e.connected)){e.configApplying=!0,e.lastError=null;try{const t=e.configFormMode==="form"&&e.configForm?Ze(e.configForm):e.configRaw,n=e.configSnapshot?.hash;if(!n){e.lastError="Config hash missing; reload and retry.";return}await e.client.request("config.apply",{raw:t,baseHash:n,sessionKey:e.applySessionKey}),e.configFormDirty=!1,await me(e)}catch(t){e.lastError=String(t)}finally{e.configApplying=!1}}}async function Kl(e){if(!(!e.client||!e.connected)){e.updateRunning=!0,e.lastError=null;try{await e.client.request("update.run",{sessionKey:e.applySessionKey})}catch(t){e.lastError=String(t)}finally{e.updateRunning=!1}}}function Nt(e,t,n){const s=Ne(e.configForm??e.configSnapshot?.config??{});ia(s,t,n),e.configForm=s,e.configFormDirty=!0,e.configFormMode==="form"&&(e.configRaw=Ze(s))}function Gi(e,t){const n=Ne(e.configForm??e.configSnapshot?.config??{});oa(n,t),e.configForm=n,e.configFormDirty=!0,e.configFormMode==="form"&&(e.configRaw=Ze(n))}async function St(e){if(!(!e.client||!e.connected))try{const t=await e.client.request("cron.status",{});e.cronStatus=t}catch(t){e.cronError=String(t)}}async function ln(e){if(!(!e.client||!e.connected)&&!e.cronLoading){e.cronLoading=!0,e.cronError=null;try{const t=await e.client.request("cron.list",{includeDisabled:!0});e.cronJobs=Array.isArray(t.jobs)?t.jobs:[]}catch(t){e.cronError=String(t)}finally{e.cronLoading=!1}}}function Hl(e){if(e.scheduleKind==="at"){const n=Date.parse(e.scheduleAt);if(!Number.isFinite(n))throw new Error("Invalid run time.");return{kind:"at",atMs:n}}if(e.scheduleKind==="every"){const n=Gt(e.everyAmount,0);if(n<=0)throw new Error("Invalid interval amount.");const s=e.everyUnit;return{kind:"every",everyMs:n*(s==="minutes"?6e4:s==="hours"?36e5:864e5)}}const t=e.cronExpr.trim();if(!t)throw new Error("Cron expression required.");return{kind:"cron",expr:t,tz:e.cronTz.trim()||void 0}}function zl(e){if(e.payloadKind==="systemEvent"){const i=e.payloadText.trim();if(!i)throw new Error("System event text required.");return{kind:"systemEvent",text:i}}const t=e.payloadText.trim();if(!t)throw new Error("Agent message required.");const n={kind:"agentTurn",message:t};e.deliver&&(n.deliver=!0),e.channel&&(n.channel=e.channel),e.to.trim()&&(n.to=e.to.trim());const s=Gt(e.timeoutSeconds,0);return s>0&&(n.timeoutSeconds=s),n}async function jl(e){if(!(!e.client||!e.connected||e.cronBusy)){e.cronBusy=!0,e.cronError=null;try{const t=Hl(e.cronForm),n=zl(e.cronForm),s=e.cronForm.agentId.trim(),i={name:e.cronForm.name.trim(),description:e.cronForm.description.trim()||void 0,agentId:s||void 0,enabled:e.cronForm.enabled,schedule:t,sessionTarget:e.cronForm.sessionTarget,wakeMode:e.cronForm.wakeMode,payload:n,isolation:e.cronForm.postToMainPrefix.trim()&&e.cronForm.sessionTarget==="isolated"?{postToMainPrefix:e.cronForm.postToMainPrefix.trim()}:void 0};if(!i.name)throw new Error("Name required.");await e.client.request("cron.add",i),e.cronForm={...e.cronForm,name:"",description:"",payloadText:""},await ln(e),await St(e)}catch(t){e.cronError=String(t)}finally{e.cronBusy=!1}}}async function ql(e,t,n){if(!(!e.client||!e.connected||e.cronBusy)){e.cronBusy=!0,e.cronError=null;try{await e.client.request("cron.update",{id:t.id,patch:{enabled:n}}),await ln(e),await St(e)}catch(s){e.cronError=String(s)}finally{e.cronBusy=!1}}}async function Wl(e,t){if(!(!e.client||!e.connected||e.cronBusy)){e.cronBusy=!0,e.cronError=null;try{await e.client.request("cron.run",{id:t.id,mode:"force"}),await ra(e,t.id)}catch(n){e.cronError=String(n)}finally{e.cronBusy=!1}}}async function Vl(e,t){if(!(!e.client||!e.connected||e.cronBusy)){e.cronBusy=!0,e.cronError=null;try{await e.client.request("cron.remove",{id:t.id}),e.cronRunsJobId===t.id&&(e.cronRunsJobId=null,e.cronRuns=[]),await ln(e),await St(e)}catch(n){e.cronError=String(n)}finally{e.cronBusy=!1}}}async function ra(e,t){if(!(!e.client||!e.connected))try{const n=await e.client.request("cron.runs",{id:t,limit:50});e.cronRunsJobId=t,e.cronRuns=Array.isArray(n.entries)?n.entries:[]}catch(n){e.cronError=String(n)}}async function oe(e,t){if(!(!e.client||!e.connected)&&!e.channelsLoading){e.channelsLoading=!0,e.channelsError=null;try{const n=await e.client.request("channels.status",{probe:t,timeoutMs:8e3});e.channelsSnapshot=n,e.channelsLastSuccess=Date.now()}catch(n){e.channelsError=String(n)}finally{e.channelsLoading=!1}}}async function Gl(e,t){if(!(!e.client||!e.connected||e.whatsappBusy)){e.whatsappBusy=!0;try{const n=await e.client.request("web.login.start",{force:t,timeoutMs:3e4});e.whatsappLoginMessage=n.message??null,e.whatsappLoginQrDataUrl=n.qrDataUrl??null,e.whatsappLoginConnected=null}catch(n){e.whatsappLoginMessage=String(n),e.whatsappLoginQrDataUrl=null,e.whatsappLoginConnected=null}finally{e.whatsappBusy=!1}}}async function Yl(e){if(!(!e.client||!e.connected||e.whatsappBusy)){e.whatsappBusy=!0;try{const t=await e.client.request("web.login.wait",{timeoutMs:12e4});e.whatsappLoginMessage=t.message??null,e.whatsappLoginConnected=t.connected??null,t.connected&&(e.whatsappLoginQrDataUrl=null)}catch(t){e.whatsappLoginMessage=String(t),e.whatsappLoginConnected=null}finally{e.whatsappBusy=!1}}}async function Ql(e){if(!(!e.client||!e.connected||e.whatsappBusy)){e.whatsappBusy=!0;try{await e.client.request("channels.logout",{channel:"whatsapp"}),e.whatsappLoginMessage="Logged out.",e.whatsappLoginQrDataUrl=null,e.whatsappLoginConnected=null}catch(t){e.whatsappLoginMessage=String(t)}finally{e.whatsappBusy=!1}}}async function cn(e){if(!(!e.client||!e.connected)&&!e.debugLoading){e.debugLoading=!0;try{const[t,n,s,i]=await Promise.all([e.client.request("status",{}),e.client.request("health",{}),e.client.request("models.list",{}),e.client.request("last-heartbeat",{})]);e.debugStatus=t,e.debugHealth=n;const o=s;e.debugModels=Array.isArray(o?.models)?o?.models:[],e.debugHeartbeat=i}catch(t){e.debugCallError=String(t)}finally{e.debugLoading=!1}}}async function Jl(e){if(!(!e.client||!e.connected)){e.debugCallError=null,e.debugCallResult=null;try{const t=e.debugCallParams.trim()?JSON.parse(e.debugCallParams):{},n=await e.client.request(e.debugCallMethod.trim(),t);e.debugCallResult=JSON.stringify(n,null,2)}catch(t){e.debugCallError=String(t)}}}const Zl=2e3,Xl=new Set(["trace","debug","info","warn","error","fatal"]);function ec(e){if(typeof e!="string")return null;const t=e.trim();if(!t.startsWith("{")||!t.endsWith("}"))return null;try{const n=JSON.parse(t);return!n||typeof n!="object"?null:n}catch{return null}}function tc(e){if(typeof e!="string")return null;const t=e.toLowerCase();return Xl.has(t)?t:null}function nc(e){if(!e.trim())return{raw:e,message:e};try{const t=JSON.parse(e),n=t&&typeof t._meta=="object"&&t._meta!==null?t._meta:null,s=typeof t.time=="string"?t.time:typeof n?.date=="string"?n?.date:null,i=tc(n?.logLevelName??n?.level),o=typeof t[0]=="string"?t[0]:typeof n?.name=="string"?n?.name:null,a=ec(o);let c=null;a&&(typeof a.subsystem=="string"?c=a.subsystem:typeof a.module=="string"&&(c=a.module)),!c&&o&&o.length<120&&(c=o);let r=null;return typeof t[1]=="string"?r=t[1]:!a&&typeof t[0]=="string"?r=t[0]:typeof t.message=="string"&&(r=t.message),{raw:e,time:s,level:i,subsystem:c,message:r??e,meta:n??void 0}}catch{return{raw:e,message:e}}}async function Ms(e,t){if(!(!e.client||!e.connected)&&!(e.logsLoading&&!t?.quiet)){t?.quiet||(e.logsLoading=!0),e.logsError=null;try{const s=await e.client.request("logs.tail",{cursor:t?.reset?void 0:e.logsCursor??void 0,limit:e.logsLimit,maxBytes:e.logsMaxBytes}),o=(Array.isArray(s.lines)?s.lines.filter(c=>typeof c=="string"):[]).map(nc),a=!!(t?.reset||s.reset||e.logsCursor==null);e.logsEntries=a?o:[...e.logsEntries,...o].slice(-Zl),typeof s.cursor=="number"&&(e.logsCursor=s.cursor),typeof s.file=="string"&&(e.logsFile=s.file),e.logsTruncated=!!s.truncated,e.logsLastFetchAt=Date.now()}catch(n){e.logsError=String(n)}finally{t?.quiet||(e.logsLoading=!1)}}}const la={p:0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffedn,n:0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn,h:8n,a:0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffecn,d:0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3n,Gx:0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51an,Gy:0x6666666666666666666666666666666666666666666666666666666666666658n},{p:W,n:jt,Gx:Yi,Gy:Qi,a:Fn,d:Un,h:sc}=la,Oe=32,Ps=64,ic=(...e)=>{"captureStackTrace"in Error&&typeof Error.captureStackTrace=="function"&&Error.captureStackTrace(...e)},H=(e="")=>{const t=new Error(e);throw ic(t,H),t},oc=e=>typeof e=="bigint",ac=e=>typeof e=="string",rc=e=>e instanceof Uint8Array||ArrayBuffer.isView(e)&&e.constructor.name==="Uint8Array",Ae=(e,t,n="")=>{const s=rc(e),i=e?.length,o=t!==void 0;if(!s||o&&i!==t){const a=n&&`"${n}" `,c=o?` of length ${t}`:"",r=s?`length=${i}`:`type=${typeof e}`;H(a+"expected Uint8Array"+c+", got "+r)}return e},dn=e=>new Uint8Array(e),ca=e=>Uint8Array.from(e),da=(e,t)=>e.toString(16).padStart(t,"0"),ua=e=>Array.from(Ae(e)).map(t=>da(t,2)).join(""),ge={_0:48,_9:57,A:65,F:70,a:97,f:102},Ji=e=>{if(e>=ge._0&&e<=ge._9)return e-ge._0;if(e>=ge.A&&e<=ge.F)return e-(ge.A-10);if(e>=ge.a&&e<=ge.f)return e-(ge.a-10)},pa=e=>{const t="hex invalid";if(!ac(e))return H(t);const n=e.length,s=n/2;if(n%2)return H(t);const i=dn(s);for(let o=0,a=0;o<s;o++,a+=2){const c=Ji(e.charCodeAt(a)),r=Ji(e.charCodeAt(a+1));if(c===void 0||r===void 0)return H(t);i[o]=c*16+r}return i},fa=()=>globalThis?.crypto,lc=()=>fa()?.subtle??H("crypto.subtle must be defined, consider polyfill"),xt=(...e)=>{const t=dn(e.reduce((s,i)=>s+Ae(i).length,0));let n=0;return e.forEach(s=>{t.set(s,n),n+=s.length}),t},cc=(e=Oe)=>fa().getRandomValues(dn(e)),Yt=BigInt,Re=(e,t,n,s="bad number: out of range")=>oc(e)&&t<=e&&e<n?e:H(s),S=(e,t=W)=>{const n=e%t;return n>=0n?n:t+n},ha=e=>S(e,jt),dc=(e,t)=>{(e===0n||t<=0n)&&H("no inverse n="+e+" mod="+t);let n=S(e,t),s=t,i=0n,o=1n;for(;n!==0n;){const a=s/n,c=s%n,r=i-o*a;s=n,n=c,i=o,o=r}return s===1n?S(i,t):H("no inverse")},uc=e=>{const t=ba[e];return typeof t!="function"&&H("hashes."+e+" not set"),t},Kn=e=>e instanceof X?e:H("Point expected"),as=2n**256n;class X{static BASE;static ZERO;X;Y;Z;T;constructor(t,n,s,i){const o=as;this.X=Re(t,0n,o),this.Y=Re(n,0n,o),this.Z=Re(s,1n,o),this.T=Re(i,0n,o),Object.freeze(this)}static CURVE(){return la}static fromAffine(t){return new X(t.x,t.y,1n,S(t.x*t.y))}static fromBytes(t,n=!1){const s=Un,i=ca(Ae(t,Oe)),o=t[31];i[31]=o&-129;const a=va(i);Re(a,0n,n?as:W);const r=S(a*a),p=S(r-1n),l=S(s*r+1n);let{isValid:u,value:h}=fc(p,l);u||H("bad point: y not sqrt");const v=(h&1n)===1n,w=(o&128)!==0;return!n&&h===0n&&w&&H("bad point: x==0, isLastByteOdd"),w!==v&&(h=S(-h)),new X(h,a,1n,S(h*a))}static fromHex(t,n){return X.fromBytes(pa(t),n)}get x(){return this.toAffine().x}get y(){return this.toAffine().y}assertValidity(){const t=Fn,n=Un,s=this;if(s.is0())return H("bad point: ZERO");const{X:i,Y:o,Z:a,T:c}=s,r=S(i*i),p=S(o*o),l=S(a*a),u=S(l*l),h=S(r*t),v=S(l*S(h+p)),w=S(u+S(n*S(r*p)));if(v!==w)return H("bad point: equation left != right (1)");const $=S(i*o),x=S(a*c);return $!==x?H("bad point: equation left != right (2)"):this}equals(t){const{X:n,Y:s,Z:i}=this,{X:o,Y:a,Z:c}=Kn(t),r=S(n*c),p=S(o*i),l=S(s*c),u=S(a*i);return r===p&&l===u}is0(){return this.equals(Ge)}negate(){return new X(S(-this.X),this.Y,this.Z,S(-this.T))}double(){const{X:t,Y:n,Z:s}=this,i=Fn,o=S(t*t),a=S(n*n),c=S(2n*S(s*s)),r=S(i*o),p=t+n,l=S(S(p*p)-o-a),u=r+a,h=u-c,v=r-a,w=S(l*h),$=S(u*v),x=S(l*v),E=S(h*u);return new X(w,$,E,x)}add(t){const{X:n,Y:s,Z:i,T:o}=this,{X:a,Y:c,Z:r,T:p}=Kn(t),l=Fn,u=Un,h=S(n*a),v=S(s*c),w=S(o*u*p),$=S(i*r),x=S((n+s)*(a+c)-h-v),E=S($-w),I=S($+w),R=S(v-l*h),C=S(x*E),A=S(I*R),B=S(x*R),ue=S(E*I);return new X(C,A,ue,B)}subtract(t){return this.add(Kn(t).negate())}multiply(t,n=!0){if(!n&&(t===0n||this.is0()))return Ge;if(Re(t,1n,jt),t===1n)return this;if(this.equals(De))return Ac(t).p;let s=Ge,i=De;for(let o=this;t>0n;o=o.double(),t>>=1n)t&1n?s=s.add(o):n&&(i=i.add(o));return s}multiplyUnsafe(t){return this.multiply(t,!1)}toAffine(){const{X:t,Y:n,Z:s}=this;if(this.equals(Ge))return{x:0n,y:1n};const i=dc(s,W);S(s*i)!==1n&&H("invalid inverse");const o=S(t*i),a=S(n*i);return{x:o,y:a}}toBytes(){const{x:t,y:n}=this.assertValidity().toAffine(),s=ga(n);return s[31]|=t&1n?128:0,s}toHex(){return ua(this.toBytes())}clearCofactor(){return this.multiply(Yt(sc),!1)}isSmallOrder(){return this.clearCofactor().is0()}isTorsionFree(){let t=this.multiply(jt/2n,!1).double();return jt%2n&&(t=t.add(this)),t.is0()}}const De=new X(Yi,Qi,1n,S(Yi*Qi)),Ge=new X(0n,1n,1n,0n);X.BASE=De;X.ZERO=Ge;const ga=e=>pa(da(Re(e,0n,as),Ps)).reverse(),va=e=>Yt("0x"+ua(ca(Ae(e)).reverse())),le=(e,t)=>{let n=e;for(;t-- >0n;)n*=n,n%=W;return n},pc=e=>{const n=e*e%W*e%W,s=le(n,2n)*n%W,i=le(s,1n)*e%W,o=le(i,5n)*i%W,a=le(o,10n)*o%W,c=le(a,20n)*a%W,r=le(c,40n)*c%W,p=le(r,80n)*r%W,l=le(p,80n)*r%W,u=le(l,10n)*o%W;return{pow_p_5_8:le(u,2n)*e%W,b2:n}},Zi=0x2b8324804fc1df0b2b4d00993dfbd7a72f431806ad2fe478c4ee1b274a0ea0b0n,fc=(e,t)=>{const n=S(t*t*t),s=S(n*n*t),i=pc(e*s).pow_p_5_8;let o=S(e*n*i);const a=S(t*o*o),c=o,r=S(o*Zi),p=a===e,l=a===S(-e),u=a===S(-e*Zi);return p&&(o=c),(l||u)&&(o=r),(S(o)&1n)===1n&&(o=S(-o)),{isValid:p||l,value:o}},rs=e=>ha(va(e)),Ns=(...e)=>ba.sha512Async(xt(...e)),hc=(...e)=>uc("sha512")(xt(...e)),ma=e=>{const t=e.slice(0,Oe);t[0]&=248,t[31]&=127,t[31]|=64;const n=e.slice(Oe,Ps),s=rs(t),i=De.multiply(s),o=i.toBytes();return{head:t,prefix:n,scalar:s,point:i,pointBytes:o}},Os=e=>Ns(Ae(e,Oe)).then(ma),gc=e=>ma(hc(Ae(e,Oe))),vc=e=>Os(e).then(t=>t.pointBytes),mc=e=>Ns(e.hashable).then(e.finish),bc=(e,t,n)=>{const{pointBytes:s,scalar:i}=e,o=rs(t),a=De.multiply(o).toBytes();return{hashable:xt(a,s,n),finish:p=>{const l=ha(o+rs(p)*i);return Ae(xt(a,ga(l)),Ps)}}},yc=async(e,t)=>{const n=Ae(e),s=await Os(t),i=await Ns(s.prefix,n);return mc(bc(s,i,n))},ba={sha512Async:async e=>{const t=lc(),n=xt(e);return dn(await t.digest("SHA-512",n.buffer))},sha512:void 0},wc=(e=cc(Oe))=>e,$c={getExtendedPublicKeyAsync:Os,getExtendedPublicKey:gc,randomSecretKey:wc},Qt=8,kc=256,ya=Math.ceil(kc/Qt)+1,ls=2**(Qt-1),xc=()=>{const e=[];let t=De,n=t;for(let s=0;s<ya;s++){n=t,e.push(n);for(let i=1;i<ls;i++)n=n.add(t),e.push(n);t=n.double()}return e};let Xi;const eo=(e,t)=>{const n=t.negate();return e?n:t},Ac=e=>{const t=Xi||(Xi=xc());let n=Ge,s=De;const i=2**Qt,o=i,a=Yt(i-1),c=Yt(Qt);for(let r=0;r<ya;r++){let p=Number(e&a);e>>=c,p>ls&&(p-=o,e+=1n);const l=r*ls,u=l,h=l+Math.abs(p)-1,v=r%2!==0,w=p<0;p===0?s=s.add(eo(v,t[u])):n=n.add(eo(w,t[h]))}return e!==0n&&H("invalid wnaf"),{p:n,f:s}},Hn="clawdbot-device-identity-v1";function cs(e){let t="";for(const n of e)t+=String.fromCharCode(n);return btoa(t).replaceAll("+","-").replaceAll("/","_").replace(/=+$/g,"")}function wa(e){const t=e.replaceAll("-","+").replaceAll("_","/"),n=t+"=".repeat((4-t.length%4)%4),s=atob(n),i=new Uint8Array(s.length);for(let o=0;o<s.length;o+=1)i[o]=s.charCodeAt(o);return i}function Sc(e){return Array.from(e).map(t=>t.toString(16).padStart(2,"0")).join("")}async function $a(e){const t=await crypto.subtle.digest("SHA-256",e);return Sc(new Uint8Array(t))}async function _c(){const e=$c.randomSecretKey(),t=await vc(e);return{deviceId:await $a(t),publicKey:cs(t),privateKey:cs(e)}}async function Ds(){try{const n=localStorage.getItem(Hn);if(n){const s=JSON.parse(n);if(s?.version===1&&typeof s.deviceId=="string"&&typeof s.publicKey=="string"&&typeof s.privateKey=="string"){const i=await $a(wa(s.publicKey));if(i!==s.deviceId){const o={...s,deviceId:i};return localStorage.setItem(Hn,JSON.stringify(o)),{deviceId:i,publicKey:s.publicKey,privateKey:s.privateKey}}return{deviceId:s.deviceId,publicKey:s.publicKey,privateKey:s.privateKey}}}}catch{}const e=await _c(),t={version:1,deviceId:e.deviceId,publicKey:e.publicKey,privateKey:e.privateKey,createdAtMs:Date.now()};return localStorage.setItem(Hn,JSON.stringify(t)),e}async function Tc(e,t){const n=wa(e),s=new TextEncoder().encode(t),i=await yc(s,n);return cs(i)}const ka="clawdbot.device.auth.v1";function Bs(e){return e.trim()}function Ec(e){if(!Array.isArray(e))return[];const t=new Set;for(const n of e){const s=n.trim();s&&t.add(s)}return[...t].sort()}function Fs(){try{const e=window.localStorage.getItem(ka);if(!e)return null;const t=JSON.parse(e);return!t||t.version!==1||!t.deviceId||typeof t.deviceId!="string"||!t.tokens||typeof t.tokens!="object"?null:t}catch{return null}}function xa(e){try{window.localStorage.setItem(ka,JSON.stringify(e))}catch{}}function Cc(e){const t=Fs();if(!t||t.deviceId!==e.deviceId)return null;const n=Bs(e.role),s=t.tokens[n];return!s||typeof s.token!="string"?null:s}function Aa(e){const t=Bs(e.role),n={version:1,deviceId:e.deviceId,tokens:{}},s=Fs();s&&s.deviceId===e.deviceId&&(n.tokens={...s.tokens});const i={token:e.token,role:t,scopes:Ec(e.scopes),updatedAtMs:Date.now()};return n.tokens[t]=i,xa(n),i}function Sa(e){const t=Fs();if(!t||t.deviceId!==e.deviceId)return;const n=Bs(e.role);if(!t.tokens[n])return;const s={...t,tokens:{...t.tokens}};delete s.tokens[n],xa(s)}async function Se(e,t){if(!(!e.client||!e.connected)&&!e.devicesLoading){e.devicesLoading=!0,t?.quiet||(e.devicesError=null);try{const n=await e.client.request("device.pair.list",{});e.devicesList={pending:Array.isArray(n?.pending)?n.pending:[],paired:Array.isArray(n?.paired)?n.paired:[]}}catch(n){t?.quiet||(e.devicesError=String(n))}finally{e.devicesLoading=!1}}}async function Ic(e,t){if(!(!e.client||!e.connected))try{await e.client.request("device.pair.approve",{requestId:t}),await Se(e)}catch(n){e.devicesError=String(n)}}async function Lc(e,t){if(!(!e.client||!e.connected||!window.confirm("Reject this device pairing request?")))try{await e.client.request("device.pair.reject",{requestId:t}),await Se(e)}catch(s){e.devicesError=String(s)}}async function Rc(e,t){if(!(!e.client||!e.connected))try{const n=await e.client.request("device.token.rotate",t);if(n?.token){const s=await Ds(),i=n.role??t.role;(n.deviceId===s.deviceId||t.deviceId===s.deviceId)&&Aa({deviceId:s.deviceId,role:i,token:n.token,scopes:n.scopes??t.scopes??[]}),window.prompt("New device token (copy and store securely):",n.token)}await Se(e)}catch(n){e.devicesError=String(n)}}async function Mc(e,t){if(!(!e.client||!e.connected||!window.confirm(`Revoke token for ${t.deviceId} (${t.role})?`)))try{await e.client.request("device.token.revoke",t);const s=await Ds();t.deviceId===s.deviceId&&Sa({deviceId:s.deviceId,role:t.role}),await Se(e)}catch(s){e.devicesError=String(s)}}async function un(e,t){if(!(!e.client||!e.connected)&&!e.nodesLoading){e.nodesLoading=!0,t?.quiet||(e.lastError=null);try{const n=await e.client.request("node.list",{});e.nodes=Array.isArray(n.nodes)?n.nodes:[]}catch(n){t?.quiet||(e.lastError=String(n))}finally{e.nodesLoading=!1}}}function Pc(e){if(!e||e.kind==="gateway")return{method:"exec.approvals.get",params:{}};const t=e.nodeId.trim();return t?{method:"exec.approvals.node.get",params:{nodeId:t}}:null}function Nc(e,t){if(!e||e.kind==="gateway")return{method:"exec.approvals.set",params:t};const n=e.nodeId.trim();return n?{method:"exec.approvals.node.set",params:{...t,nodeId:n}}:null}async function Us(e,t){if(!(!e.client||!e.connected)&&!e.execApprovalsLoading){e.execApprovalsLoading=!0,e.lastError=null;try{const n=Pc(t);if(!n){e.lastError="Select a node before loading exec approvals.";return}const s=await e.client.request(n.method,n.params);Oc(e,s)}catch(n){e.lastError=String(n)}finally{e.execApprovalsLoading=!1}}}function Oc(e,t){e.execApprovalsSnapshot=t,e.execApprovalsDirty||(e.execApprovalsForm=Ne(t.file??{}))}async function Dc(e,t){if(!(!e.client||!e.connected)){e.execApprovalsSaving=!0,e.lastError=null;try{const n=e.execApprovalsSnapshot?.hash;if(!n){e.lastError="Exec approvals hash missing; reload and retry.";return}const s=e.execApprovalsForm??e.execApprovalsSnapshot?.file??{},i=Nc(t,{file:s,baseHash:n});if(!i){e.lastError="Select a node before saving exec approvals.";return}await e.client.request(i.method,i.params),e.execApprovalsDirty=!1,await Us(e,t)}catch(n){e.lastError=String(n)}finally{e.execApprovalsSaving=!1}}}function Bc(e,t,n){const s=Ne(e.execApprovalsForm??e.execApprovalsSnapshot?.file??{});ia(s,t,n),e.execApprovalsForm=s,e.execApprovalsDirty=!0}function Fc(e,t){const n=Ne(e.execApprovalsForm??e.execApprovalsSnapshot?.file??{});oa(n,t),e.execApprovalsForm=n,e.execApprovalsDirty=!0}async function Ks(e){if(!(!e.client||!e.connected)&&!e.presenceLoading){e.presenceLoading=!0,e.presenceError=null,e.presenceStatus=null;try{const t=await e.client.request("system-presence",{});Array.isArray(t)?(e.presenceEntries=t,e.presenceStatus=t.length===0?"No instances yet.":null):(e.presenceEntries=[],e.presenceStatus="No presence payload.")}catch(t){e.presenceError=String(t)}finally{e.presenceLoading=!1}}}function Xe(e,t,n){if(!t.trim())return;const s={...e.skillMessages};n?s[t]=n:delete s[t],e.skillMessages=s}function pn(e){return e instanceof Error?e.message:String(e)}async function _t(e,t){if(t?.clearMessages&&Object.keys(e.skillMessages).length>0&&(e.skillMessages={}),!(!e.client||!e.connected)&&!e.skillsLoading){e.skillsLoading=!0,e.skillsError=null;try{const n=await e.client.request("skills.status",{});n&&(e.skillsReport=n)}catch(n){e.skillsError=pn(n)}finally{e.skillsLoading=!1}}}function Uc(e,t,n){e.skillEdits={...e.skillEdits,[t]:n}}async function Kc(e,t,n){if(!(!e.client||!e.connected)){e.skillsBusyKey=t,e.skillsError=null;try{await e.client.request("skills.update",{skillKey:t,enabled:n}),await _t(e),Xe(e,t,{kind:"success",message:n?"Skill enabled":"Skill disabled"})}catch(s){const i=pn(s);e.skillsError=i,Xe(e,t,{kind:"error",message:i})}finally{e.skillsBusyKey=null}}}async function Hc(e,t){if(!(!e.client||!e.connected)){e.skillsBusyKey=t,e.skillsError=null;try{const n=e.skillEdits[t]??"";await e.client.request("skills.update",{skillKey:t,apiKey:n}),await _t(e),Xe(e,t,{kind:"success",message:"API key saved"})}catch(n){const s=pn(n);e.skillsError=s,Xe(e,t,{kind:"error",message:s})}finally{e.skillsBusyKey=null}}}async function zc(e,t,n,s){if(!(!e.client||!e.connected)){e.skillsBusyKey=t,e.skillsError=null;try{const i=await e.client.request("skills.install",{name:n,installId:s,timeoutMs:12e4});await _t(e),Xe(e,t,{kind:"success",message:i?.message??"Installed"})}catch(i){const o=pn(i);e.skillsError=o,Xe(e,t,{kind:"error",message:o})}finally{e.skillsBusyKey=null}}}function jc(){return typeof window>"u"||typeof window.matchMedia!="function"||window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}function Hs(e){return e==="system"?jc():e}const Ot=e=>Number.isNaN(e)?.5:e<=0?0:e>=1?1:e,qc=()=>typeof window>"u"||typeof window.matchMedia!="function"?!1:window.matchMedia("(prefers-reduced-motion: reduce)").matches??!1,Dt=e=>{e.classList.remove("theme-transition"),e.style.removeProperty("--theme-switch-x"),e.style.removeProperty("--theme-switch-y")},Wc=({nextTheme:e,applyTheme:t,context:n,currentTheme:s})=>{if(s===e)return;const i=globalThis.document??null;if(!i){t();return}const o=i.documentElement,a=i,c=qc();if(!!a.startViewTransition&&!c){let p=.5,l=.5;if(n?.pointerClientX!==void 0&&n?.pointerClientY!==void 0&&typeof window<"u")p=Ot(n.pointerClientX/window.innerWidth),l=Ot(n.pointerClientY/window.innerHeight);else if(n?.element){const u=n.element.getBoundingClientRect();u.width>0&&u.height>0&&typeof window<"u"&&(p=Ot((u.left+u.width/2)/window.innerWidth),l=Ot((u.top+u.height/2)/window.innerHeight))}o.style.setProperty("--theme-switch-x",`${p*100}%`),o.style.setProperty("--theme-switch-y",`${l*100}%`),o.classList.add("theme-transition");try{const u=a.startViewTransition?.(()=>{t()});u?.finished?u.finished.finally(()=>Dt(o)):Dt(o)}catch{Dt(o),t()}return}t(),Dt(o)};function Vc(e){e.nodesPollInterval==null&&(e.nodesPollInterval=window.setInterval(()=>{un(e,{quiet:!0})},5e3))}function Gc(e){e.nodesPollInterval!=null&&(clearInterval(e.nodesPollInterval),e.nodesPollInterval=null)}function zs(e){e.logsPollInterval==null&&(e.logsPollInterval=window.setInterval(()=>{e.tab==="logs"&&Ms(e,{quiet:!0})},2e3))}function js(e){e.logsPollInterval!=null&&(clearInterval(e.logsPollInterval),e.logsPollInterval=null)}function qs(e){e.debugPollInterval==null&&(e.debugPollInterval=window.setInterval(()=>{e.tab==="debug"&&cn(e)},3e3))}function Ws(e){e.debugPollInterval!=null&&(clearInterval(e.debugPollInterval),e.debugPollInterval=null)}function $e(e,t){const n={...t,lastActiveSessionKey:t.lastActiveSessionKey?.trim()||t.sessionKey.trim()||"main"};e.settings=n,ll(n),t.theme!==e.theme&&(e.theme=t.theme,fn(e,Hs(t.theme))),e.applySessionKey=e.settings.lastActiveSessionKey}function _a(e,t){const n=t.trim();n&&e.settings.lastActiveSessionKey!==n&&$e(e,{...e.settings,lastActiveSessionKey:n})}function Yc(e){if(!window.location.search)return;const t=new URLSearchParams(window.location.search),n=t.get("token"),s=t.get("password"),i=t.get("session"),o=t.get("gatewayUrl");let a=!1;if(n!=null){const r=n.trim();r&&r!==e.settings.token&&$e(e,{...e.settings,token:r}),t.delete("token"),a=!0}if(s!=null){const r=s.trim();r&&(e.password=r),t.delete("password"),a=!0}if(i!=null){const r=i.trim();r&&(e.sessionKey=r,$e(e,{...e.settings,sessionKey:r,lastActiveSessionKey:r}))}if(o!=null){const r=o.trim();r&&r!==e.settings.gatewayUrl&&$e(e,{...e.settings,gatewayUrl:r}),t.delete("gatewayUrl"),a=!0}if(!a)return;const c=new URL(window.location.href);c.search=t.toString(),window.history.replaceState({},"",c.toString())}function Qc(e,t){e.tab!==t&&(e.tab=t),t==="chat"&&(e.chatHasAutoScrolled=!1),t==="logs"?zs(e):js(e),t==="debug"?qs(e):Ws(e),Vs(e),Ea(e,t,!1)}function Jc(e,t,n){Wc({nextTheme:t,applyTheme:()=>{e.theme=t,$e(e,{...e.settings,theme:t}),fn(e,Hs(t))},context:n,currentTheme:e.theme})}async function Vs(e){e.tab==="overview"&&await Ca(e),e.tab==="channels"&&await od(e),e.tab==="instances"&&await Ks(e),e.tab==="sessions"&&await tt(e),e.tab==="cron"&&await Gs(e),e.tab==="skills"&&await _t(e),e.tab==="nodes"&&(await un(e),await Se(e),await me(e),await Us(e)),e.tab==="chat"&&(await dd(e),rn(e,!e.chatHasAutoScrolled)),e.tab==="config"&&(await aa(e),await me(e)),e.tab==="debug"&&(await cn(e),e.eventLog=e.eventLogBuffer),e.tab==="logs"&&(e.logsAtBottom=!0,await Ms(e,{reset:!0}),sa(e,!0))}function Zc(){if(typeof window>"u")return"";const e=window.__CLAWDBOT_CONTROL_UI_BASE_PATH__;return typeof e=="string"&&e.trim()?on(e):dl(window.location.pathname)}function Xc(e){e.theme=e.settings.theme??"system",fn(e,Hs(e.theme))}function fn(e,t){if(e.themeResolved=t,typeof document>"u")return;const n=document.documentElement;n.dataset.theme=t,n.style.colorScheme=t}function ed(e){if(typeof window>"u"||typeof window.matchMedia!="function")return;if(e.themeMedia=window.matchMedia("(prefers-color-scheme: dark)"),e.themeMediaHandler=n=>{e.theme==="system"&&fn(e,n.matches?"dark":"light")},typeof e.themeMedia.addEventListener=="function"){e.themeMedia.addEventListener("change",e.themeMediaHandler);return}e.themeMedia.addListener(e.themeMediaHandler)}function td(e){if(!e.themeMedia||!e.themeMediaHandler)return;if(typeof e.themeMedia.removeEventListener=="function"){e.themeMedia.removeEventListener("change",e.themeMediaHandler);return}e.themeMedia.removeListener(e.themeMediaHandler),e.themeMedia=null,e.themeMediaHandler=null}function nd(e,t){if(typeof window>"u")return;const n=ea(window.location.pathname,e.basePath)??"chat";Ta(e,n),Ea(e,n,t)}function sd(e){if(typeof window>"u")return;const t=ea(window.location.pathname,e.basePath);if(!t)return;const s=new URL(window.location.href).searchParams.get("session")?.trim();s&&(e.sessionKey=s,$e(e,{...e.settings,sessionKey:s,lastActiveSessionKey:s})),Ta(e,t)}function Ta(e,t){e.tab!==t&&(e.tab=t),t==="chat"&&(e.chatHasAutoScrolled=!1),t==="logs"?zs(e):js(e),t==="debug"?qs(e):Ws(e),e.connected&&Vs(e)}function Ea(e,t,n){if(typeof window>"u")return;const s=$t(Is(t,e.basePath)),i=$t(window.location.pathname),o=new URL(window.location.href);t==="chat"&&e.sessionKey?o.searchParams.set("session",e.sessionKey):o.searchParams.delete("session"),i!==s&&(o.pathname=s),n?window.history.replaceState({},"",o.toString()):window.history.pushState({},"",o.toString())}function id(e,t,n){if(typeof window>"u")return;const s=new URL(window.location.href);s.searchParams.set("session",t),window.history.replaceState({},"",s.toString())}async function Ca(e){await Promise.all([oe(e,!1),Ks(e),tt(e),St(e),cn(e)])}async function od(e){await Promise.all([oe(e,!0),aa(e),me(e)])}async function Gs(e){await Promise.all([oe(e,!1),St(e),ln(e)])}function Ia(e){return e.chatSending||!!e.chatRunId}function ad(e){const t=e.trim();if(!t)return!1;const n=t.toLowerCase();return n==="/stop"?!0:n==="stop"||n==="esc"||n==="abort"||n==="wait"||n==="exit"}async function La(e){e.connected&&(e.chatMessage="",await $l(e))}function rd(e,t){const n=t.trim();n&&(e.chatQueue=[...e.chatQueue,{id:Ls(),text:n,createdAt:Date.now()}])}async function Ra(e,t,n){Rs(e);const s=await wl(e,t);return!s&&n?.previousDraft!=null&&(e.chatMessage=n.previousDraft),s&&_a(e,e.sessionKey),s&&n?.restoreDraft&&n.previousDraft?.trim()&&(e.chatMessage=n.previousDraft),rn(e),s&&!e.chatRunId&&Ma(e),s}async function Ma(e){if(!e.connected||Ia(e))return;const[t,...n]=e.chatQueue;if(!t)return;e.chatQueue=n,await Ra(e,t.text)||(e.chatQueue=[t,...e.chatQueue])}function ld(e,t){e.chatQueue=e.chatQueue.filter(n=>n.id!==t)}async function cd(e,t,n){if(!e.connected)return;const s=e.chatMessage,i=(t??e.chatMessage).trim();if(i){if(ad(i)){await La(e);return}if(t==null&&(e.chatMessage=""),Ia(e)){rd(e,i);return}await Ra(e,i,{previousDraft:t==null?s:void 0,restoreDraft:!!(t&&n?.restoreDraft)})}}async function dd(e){await Promise.all([Je(e),tt(e),ds(e)]),rn(e,!0)}const ud=Ma;function pd(e){const t=Jo(e.sessionKey);return t?.agentId?t.agentId:e.hello?.snapshot?.sessionDefaults?.defaultAgentId?.trim()||"main"}function fd(e,t){const n=on(e),s=encodeURIComponent(t);return n?`${n}/avatar/${s}?meta=1`:`/avatar/${s}?meta=1`}async function ds(e){if(!e.connected){e.chatAvatarUrl=null;return}const t=pd(e);if(!t){e.chatAvatarUrl=null;return}e.chatAvatarUrl=null;const n=fd(e.basePath,t);try{const s=await fetch(n,{method:"GET"});if(!s.ok){e.chatAvatarUrl=null;return}const i=await s.json(),o=typeof i.avatarUrl=="string"?i.avatarUrl.trim():"";e.chatAvatarUrl=o||null}catch{e.chatAvatarUrl=null}}const Pa={CHILD:2},Na=e=>(...t)=>({_$litDirective$:e,values:t});let Oa=class{constructor(t){}get _$AU(){return this._$AM._$AU}_$AT(t,n,s){this._$Ct=t,this._$AM=n,this._$Ci=s}_$AS(t,n){return this.update(t,n)}update(t,n){return this.render(...n)}};const{I:hd}=Jr,to=e=>e,no=()=>document.createComment(""),at=(e,t,n)=>{const s=e._$AA.parentNode,i=t===void 0?e._$AB:t._$AA;if(n===void 0){const o=s.insertBefore(no(),i),a=s.insertBefore(no(),i);n=new hd(o,a,e,e.options)}else{const o=n._$AB.nextSibling,a=n._$AM,c=a!==e;if(c){let r;n._$AQ?.(e),n._$AM=e,n._$AP!==void 0&&(r=e._$AU)!==a._$AU&&n._$AP(r)}if(o!==i||c){let r=n._$AA;for(;r!==o;){const p=to(r).nextSibling;to(s).insertBefore(r,i),r=p}}}return n},Ie=(e,t,n=e)=>(e._$AI(t,n),e),gd={},vd=(e,t=gd)=>e._$AH=t,md=e=>e._$AH,zn=e=>{e._$AR(),e._$AA.remove()};const so=(e,t,n)=>{const s=new Map;for(let i=t;i<=n;i++)s.set(e[i],i);return s},Da=Na(class extends Oa{constructor(e){if(super(e),e.type!==Pa.CHILD)throw Error("repeat() can only be used in text expressions")}dt(e,t,n){let s;n===void 0?n=t:t!==void 0&&(s=t);const i=[],o=[];let a=0;for(const c of e)i[a]=s?s(c,a):a,o[a]=n(c,a),a++;return{values:o,keys:i}}render(e,t,n){return this.dt(e,t,n).values}update(e,[t,n,s]){const i=md(e),{values:o,keys:a}=this.dt(t,n,s);if(!Array.isArray(i))return this.ut=a,o;const c=this.ut??=[],r=[];let p,l,u=0,h=i.length-1,v=0,w=o.length-1;for(;u<=h&&v<=w;)if(i[u]===null)u++;else if(i[h]===null)h--;else if(c[u]===a[v])r[v]=Ie(i[u],o[v]),u++,v++;else if(c[h]===a[w])r[w]=Ie(i[h],o[w]),h--,w--;else if(c[u]===a[w])r[w]=Ie(i[u],o[w]),at(e,r[w+1],i[u]),u++,w--;else if(c[h]===a[v])r[v]=Ie(i[h],o[v]),at(e,i[u],i[h]),h--,v++;else if(p===void 0&&(p=so(a,v,w),l=so(c,u,h)),p.has(c[u]))if(p.has(c[h])){const $=l.get(a[v]),x=$!==void 0?i[$]:null;if(x===null){const E=at(e,i[u]);Ie(E,o[v]),r[v]=E}else r[v]=Ie(x,o[v]),at(e,i[u],x),i[$]=null;v++}else zn(i[h]),h--;else zn(i[u]),u++;for(;v<=w;){const $=at(e,r[w+1]);Ie($,o[v]),r[v++]=$}for(;u<=h;){const $=i[u++];$!==null&&zn($)}return this.ut=a,vd(e,r),xe}});function Ba(e){const t=e;let n=typeof t.role=="string"?t.role:"unknown";const s=typeof t.toolCallId=="string"||typeof t.tool_call_id=="string",i=t.content,o=Array.isArray(i)?i:null,a=Array.isArray(o)&&o.some(u=>{const h=u,v=String(h.type??"").toLowerCase();return v==="toolcall"||v==="tool_call"||v==="tooluse"||v==="tool_use"||v==="toolresult"||v==="tool_result"||v==="tool_call"||v==="tool_result"||typeof h.name=="string"&&h.arguments!=null}),c=typeof t.toolName=="string"||typeof t.tool_name=="string";(s||a||c)&&(n="toolResult");let r=[];typeof t.content=="string"?r=[{type:"text",text:t.content}]:Array.isArray(t.content)?r=t.content.map(u=>({type:u.type||"text",text:u.text,name:u.name,args:u.args||u.arguments})):typeof t.text=="string"&&(r=[{type:"text",text:t.text}]);const p=typeof t.timestamp=="number"?t.timestamp:Date.now(),l=typeof t.id=="string"?t.id:void 0;return{role:n,content:r,timestamp:p,id:l}}function Ys(e){const t=e.toLowerCase();return t==="toolresult"||t==="tool_result"||t==="tool"||t==="function"||t==="toolresult"?"tool":t==="assistant"?"assistant":t==="user"?"user":t==="system"?"system":e}function Fa(e){const t=e,n=typeof t.role=="string"?t.role.toLowerCase():"";return n==="toolresult"||n==="tool_result"}class us extends Oa{constructor(t){if(super(t),this.it=g,t.type!==Pa.CHILD)throw Error(this.constructor.directiveName+"() can only be used in child bindings")}render(t){if(t===g||t==null)return this._t=void 0,this.it=t;if(t===xe)return t;if(typeof t!="string")throw Error(this.constructor.directiveName+"() called with a non-string value");if(t===this.it)return this._t;this.it=t;const n=[t];return n.raw=n,this._t={_$litType$:this.constructor.resultType,strings:n,values:[]}}}us.directiveName="unsafeHTML",us.resultType=1;const ps=Na(us);const{entries:Ua,setPrototypeOf:io,isFrozen:bd,getPrototypeOf:yd,getOwnPropertyDescriptor:wd}=Object;let{freeze:Q,seal:te,create:fs}=Object,{apply:hs,construct:gs}=typeof Reflect<"u"&&Reflect;Q||(Q=function(t){return t});te||(te=function(t){return t});hs||(hs=function(t,n){for(var s=arguments.length,i=new Array(s>2?s-2:0),o=2;o<s;o++)i[o-2]=arguments[o];return t.apply(n,i)});gs||(gs=function(t){for(var n=arguments.length,s=new Array(n>1?n-1:0),i=1;i<n;i++)s[i-1]=arguments[i];return new t(...s)});const Bt=J(Array.prototype.forEach),$d=J(Array.prototype.lastIndexOf),oo=J(Array.prototype.pop),rt=J(Array.prototype.push),kd=J(Array.prototype.splice),qt=J(String.prototype.toLowerCase),jn=J(String.prototype.toString),qn=J(String.prototype.match),lt=J(String.prototype.replace),xd=J(String.prototype.indexOf),Ad=J(String.prototype.trim),ne=J(Object.prototype.hasOwnProperty),G=J(RegExp.prototype.test),ct=Sd(TypeError);function J(e){return function(t){t instanceof RegExp&&(t.lastIndex=0);for(var n=arguments.length,s=new Array(n>1?n-1:0),i=1;i<n;i++)s[i-1]=arguments[i];return hs(e,t,s)}}function Sd(e){return function(){for(var t=arguments.length,n=new Array(t),s=0;s<t;s++)n[s]=arguments[s];return gs(e,n)}}function L(e,t){let n=arguments.length>2&&arguments[2]!==void 0?arguments[2]:qt;io&&io(e,null);let s=t.length;for(;s--;){let i=t[s];if(typeof i=="string"){const o=n(i);o!==i&&(bd(t)||(t[s]=o),i=o)}e[i]=!0}return e}function _d(e){for(let t=0;t<e.length;t++)ne(e,t)||(e[t]=null);return e}function ce(e){const t=fs(null);for(const[n,s]of Ua(e))ne(e,n)&&(Array.isArray(s)?t[n]=_d(s):s&&typeof s=="object"&&s.constructor===Object?t[n]=ce(s):t[n]=s);return t}function dt(e,t){for(;e!==null;){const s=wd(e,t);if(s){if(s.get)return J(s.get);if(typeof s.value=="function")return J(s.value)}e=yd(e)}function n(){return null}return n}const ao=Q(["a","abbr","acronym","address","area","article","aside","audio","b","bdi","bdo","big","blink","blockquote","body","br","button","canvas","caption","center","cite","code","col","colgroup","content","data","datalist","dd","decorator","del","details","dfn","dialog","dir","div","dl","dt","element","em","fieldset","figcaption","figure","font","footer","form","h1","h2","h3","h4","h5","h6","head","header","hgroup","hr","html","i","img","input","ins","kbd","label","legend","li","main","map","mark","marquee","menu","menuitem","meter","nav","nobr","ol","optgroup","option","output","p","picture","pre","progress","q","rp","rt","ruby","s","samp","search","section","select","shadow","slot","small","source","spacer","span","strike","strong","style","sub","summary","sup","table","tbody","td","template","textarea","tfoot","th","thead","time","tr","track","tt","u","ul","var","video","wbr"]),Wn=Q(["svg","a","altglyph","altglyphdef","altglyphitem","animatecolor","animatemotion","animatetransform","circle","clippath","defs","desc","ellipse","enterkeyhint","exportparts","filter","font","g","glyph","glyphref","hkern","image","inputmode","line","lineargradient","marker","mask","metadata","mpath","part","path","pattern","polygon","polyline","radialgradient","rect","stop","style","switch","symbol","text","textpath","title","tref","tspan","view","vkern"]),Vn=Q(["feBlend","feColorMatrix","feComponentTransfer","feComposite","feConvolveMatrix","feDiffuseLighting","feDisplacementMap","feDistantLight","feDropShadow","feFlood","feFuncA","feFuncB","feFuncG","feFuncR","feGaussianBlur","feImage","feMerge","feMergeNode","feMorphology","feOffset","fePointLight","feSpecularLighting","feSpotLight","feTile","feTurbulence"]),Td=Q(["animate","color-profile","cursor","discard","font-face","font-face-format","font-face-name","font-face-src","font-face-uri","foreignobject","hatch","hatchpath","mesh","meshgradient","meshpatch","meshrow","missing-glyph","script","set","solidcolor","unknown","use"]),Gn=Q(["math","menclose","merror","mfenced","mfrac","mglyph","mi","mlabeledtr","mmultiscripts","mn","mo","mover","mpadded","mphantom","mroot","mrow","ms","mspace","msqrt","mstyle","msub","msup","msubsup","mtable","mtd","mtext","mtr","munder","munderover","mprescripts"]),Ed=Q(["maction","maligngroup","malignmark","mlongdiv","mscarries","mscarry","msgroup","mstack","msline","msrow","semantics","annotation","annotation-xml","mprescripts","none"]),ro=Q(["#text"]),lo=Q(["accept","action","align","alt","autocapitalize","autocomplete","autopictureinpicture","autoplay","background","bgcolor","border","capture","cellpadding","cellspacing","checked","cite","class","clear","color","cols","colspan","controls","controlslist","coords","crossorigin","datetime","decoding","default","dir","disabled","disablepictureinpicture","disableremoteplayback","download","draggable","enctype","enterkeyhint","exportparts","face","for","headers","height","hidden","high","href","hreflang","id","inert","inputmode","integrity","ismap","kind","label","lang","list","loading","loop","low","max","maxlength","media","method","min","minlength","multiple","muted","name","nonce","noshade","novalidate","nowrap","open","optimum","part","pattern","placeholder","playsinline","popover","popovertarget","popovertargetaction","poster","preload","pubdate","radiogroup","readonly","rel","required","rev","reversed","role","rows","rowspan","spellcheck","scope","selected","shape","size","sizes","slot","span","srclang","start","src","srcset","step","style","summary","tabindex","title","translate","type","usemap","valign","value","width","wrap","xmlns","slot"]),Yn=Q(["accent-height","accumulate","additive","alignment-baseline","amplitude","ascent","attributename","attributetype","azimuth","basefrequency","baseline-shift","begin","bias","by","class","clip","clippathunits","clip-path","clip-rule","color","color-interpolation","color-interpolation-filters","color-profile","color-rendering","cx","cy","d","dx","dy","diffuseconstant","direction","display","divisor","dur","edgemode","elevation","end","exponent","fill","fill-opacity","fill-rule","filter","filterunits","flood-color","flood-opacity","font-family","font-size","font-size-adjust","font-stretch","font-style","font-variant","font-weight","fx","fy","g1","g2","glyph-name","glyphref","gradientunits","gradienttransform","height","href","id","image-rendering","in","in2","intercept","k","k1","k2","k3","k4","kerning","keypoints","keysplines","keytimes","lang","lengthadjust","letter-spacing","kernelmatrix","kernelunitlength","lighting-color","local","marker-end","marker-mid","marker-start","markerheight","markerunits","markerwidth","maskcontentunits","maskunits","max","mask","mask-type","media","method","mode","min","name","numoctaves","offset","operator","opacity","order","orient","orientation","origin","overflow","paint-order","path","pathlength","patterncontentunits","patterntransform","patternunits","points","preservealpha","preserveaspectratio","primitiveunits","r","rx","ry","radius","refx","refy","repeatcount","repeatdur","restart","result","rotate","scale","seed","shape-rendering","slope","specularconstant","specularexponent","spreadmethod","startoffset","stddeviation","stitchtiles","stop-color","stop-opacity","stroke-dasharray","stroke-dashoffset","stroke-linecap","stroke-linejoin","stroke-miterlimit","stroke-opacity","stroke","stroke-width","style","surfacescale","systemlanguage","tabindex","tablevalues","targetx","targety","transform","transform-origin","text-anchor","text-decoration","text-rendering","textlength","type","u1","u2","unicode","values","viewbox","visibility","version","vert-adv-y","vert-origin-x","vert-origin-y","width","word-spacing","wrap","writing-mode","xchannelselector","ychannelselector","x","x1","x2","xmlns","y","y1","y2","z","zoomandpan"]),co=Q(["accent","accentunder","align","bevelled","close","columnsalign","columnlines","columnspan","denomalign","depth","dir","display","displaystyle","encoding","fence","frame","height","href","id","largeop","length","linethickness","lspace","lquote","mathbackground","mathcolor","mathsize","mathvariant","maxsize","minsize","movablelimits","notation","numalign","open","rowalign","rowlines","rowspacing","rowspan","rspace","rquote","scriptlevel","scriptminsize","scriptsizemultiplier","selection","separator","separators","stretchy","subscriptshift","supscriptshift","symmetric","voffset","width","xmlns"]),Ft=Q(["xlink:href","xml:id","xlink:title","xml:space","xmlns:xlink"]),Cd=te(/\{\{[\w\W]*|[\w\W]*\}\}/gm),Id=te(/<%[\w\W]*|[\w\W]*%>/gm),Ld=te(/\$\{[\w\W]*/gm),Rd=te(/^data-[\-\w.\u00B7-\uFFFF]+$/),Md=te(/^aria-[\-\w]+$/),Ka=te(/^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i),Pd=te(/^(?:\w+script|data):/i),Nd=te(/[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g),Ha=te(/^html$/i),Od=te(/^[a-z][.\w]*(-[.\w]+)+$/i);var uo=Object.freeze({__proto__:null,ARIA_ATTR:Md,ATTR_WHITESPACE:Nd,CUSTOM_ELEMENT:Od,DATA_ATTR:Rd,DOCTYPE_NAME:Ha,ERB_EXPR:Id,IS_ALLOWED_URI:Ka,IS_SCRIPT_OR_DATA:Pd,MUSTACHE_EXPR:Cd,TMPLIT_EXPR:Ld});const ut={element:1,text:3,progressingInstruction:7,comment:8,document:9},Dd=function(){return typeof window>"u"?null:window},Bd=function(t,n){if(typeof t!="object"||typeof t.createPolicy!="function")return null;let s=null;const i="data-tt-policy-suffix";n&&n.hasAttribute(i)&&(s=n.getAttribute(i));const o="dompurify"+(s?"#"+s:"");try{return t.createPolicy(o,{createHTML(a){return a},createScriptURL(a){return a}})}catch{return console.warn("TrustedTypes policy "+o+" could not be created."),null}},po=function(){return{afterSanitizeAttributes:[],afterSanitizeElements:[],afterSanitizeShadowDOM:[],beforeSanitizeAttributes:[],beforeSanitizeElements:[],beforeSanitizeShadowDOM:[],uponSanitizeAttribute:[],uponSanitizeElement:[],uponSanitizeShadowNode:[]}};function za(){let e=arguments.length>0&&arguments[0]!==void 0?arguments[0]:Dd();const t=T=>za(T);if(t.version="3.3.1",t.removed=[],!e||!e.document||e.document.nodeType!==ut.document||!e.Element)return t.isSupported=!1,t;let{document:n}=e;const s=n,i=s.currentScript,{DocumentFragment:o,HTMLTemplateElement:a,Node:c,Element:r,NodeFilter:p,NamedNodeMap:l=e.NamedNodeMap||e.MozNamedAttrMap,HTMLFormElement:u,DOMParser:h,trustedTypes:v}=e,w=r.prototype,$=dt(w,"cloneNode"),x=dt(w,"remove"),E=dt(w,"nextSibling"),I=dt(w,"childNodes"),R=dt(w,"parentNode");if(typeof a=="function"){const T=n.createElement("template");T.content&&T.content.ownerDocument&&(n=T.content.ownerDocument)}let C,A="";const{implementation:B,createNodeIterator:ue,createDocumentFragment:bn,getElementsByTagName:yn}=n,{importNode:br}=s;let V=po();t.isSupported=typeof Ua=="function"&&typeof R=="function"&&B&&B.createHTMLDocument!==void 0;const{MUSTACHE_EXPR:wn,ERB_EXPR:$n,TMPLIT_EXPR:kn,DATA_ATTR:yr,ARIA_ATTR:wr,IS_SCRIPT_OR_DATA:$r,ATTR_WHITESPACE:ri,CUSTOM_ELEMENT:kr}=uo;let{IS_ALLOWED_URI:li}=uo,K=null;const ci=L({},[...ao,...Wn,...Vn,...Gn,...ro]);let z=null;const di=L({},[...lo,...Yn,...co,...Ft]);let D=Object.seal(fs(null,{tagNameCheck:{writable:!0,configurable:!1,enumerable:!0,value:null},attributeNameCheck:{writable:!0,configurable:!1,enumerable:!0,value:null},allowCustomizedBuiltInElements:{writable:!0,configurable:!1,enumerable:!0,value:!1}})),nt=null,xn=null;const Ue=Object.seal(fs(null,{tagCheck:{writable:!0,configurable:!1,enumerable:!0,value:null},attributeCheck:{writable:!0,configurable:!1,enumerable:!0,value:null}}));let ui=!0,An=!0,pi=!1,fi=!0,Ke=!1,Et=!0,Te=!1,Sn=!1,_n=!1,He=!1,Ct=!1,It=!1,hi=!0,gi=!1;const xr="user-content-";let Tn=!0,st=!1,ze={},ae=null;const En=L({},["annotation-xml","audio","colgroup","desc","foreignobject","head","iframe","math","mi","mn","mo","ms","mtext","noembed","noframes","noscript","plaintext","script","style","svg","template","thead","title","video","xmp"]);let vi=null;const mi=L({},["audio","video","img","source","image","track"]);let Cn=null;const bi=L({},["alt","class","for","id","label","name","pattern","placeholder","role","summary","title","value","style","xmlns"]),Lt="http://www.w3.org/1998/Math/MathML",Rt="http://www.w3.org/2000/svg",pe="http://www.w3.org/1999/xhtml";let je=pe,In=!1,Ln=null;const Ar=L({},[Lt,Rt,pe],jn);let Mt=L({},["mi","mo","mn","ms","mtext"]),Pt=L({},["annotation-xml"]);const Sr=L({},["title","style","font","a","script"]);let it=null;const _r=["application/xhtml+xml","text/html"],Tr="text/html";let U=null,qe=null;const Er=n.createElement("form"),yi=function(f){return f instanceof RegExp||f instanceof Function},Rn=function(){let f=arguments.length>0&&arguments[0]!==void 0?arguments[0]:{};if(!(qe&&qe===f)){if((!f||typeof f!="object")&&(f={}),f=ce(f),it=_r.indexOf(f.PARSER_MEDIA_TYPE)===-1?Tr:f.PARSER_MEDIA_TYPE,U=it==="application/xhtml+xml"?jn:qt,K=ne(f,"ALLOWED_TAGS")?L({},f.ALLOWED_TAGS,U):ci,z=ne(f,"ALLOWED_ATTR")?L({},f.ALLOWED_ATTR,U):di,Ln=ne(f,"ALLOWED_NAMESPACES")?L({},f.ALLOWED_NAMESPACES,jn):Ar,Cn=ne(f,"ADD_URI_SAFE_ATTR")?L(ce(bi),f.ADD_URI_SAFE_ATTR,U):bi,vi=ne(f,"ADD_DATA_URI_TAGS")?L(ce(mi),f.ADD_DATA_URI_TAGS,U):mi,ae=ne(f,"FORBID_CONTENTS")?L({},f.FORBID_CONTENTS,U):En,nt=ne(f,"FORBID_TAGS")?L({},f.FORBID_TAGS,U):ce({}),xn=ne(f,"FORBID_ATTR")?L({},f.FORBID_ATTR,U):ce({}),ze=ne(f,"USE_PROFILES")?f.USE_PROFILES:!1,ui=f.ALLOW_ARIA_ATTR!==!1,An=f.ALLOW_DATA_ATTR!==!1,pi=f.ALLOW_UNKNOWN_PROTOCOLS||!1,fi=f.ALLOW_SELF_CLOSE_IN_ATTR!==!1,Ke=f.SAFE_FOR_TEMPLATES||!1,Et=f.SAFE_FOR_XML!==!1,Te=f.WHOLE_DOCUMENT||!1,He=f.RETURN_DOM||!1,Ct=f.RETURN_DOM_FRAGMENT||!1,It=f.RETURN_TRUSTED_TYPE||!1,_n=f.FORCE_BODY||!1,hi=f.SANITIZE_DOM!==!1,gi=f.SANITIZE_NAMED_PROPS||!1,Tn=f.KEEP_CONTENT!==!1,st=f.IN_PLACE||!1,li=f.ALLOWED_URI_REGEXP||Ka,je=f.NAMESPACE||pe,Mt=f.MATHML_TEXT_INTEGRATION_POINTS||Mt,Pt=f.HTML_INTEGRATION_POINTS||Pt,D=f.CUSTOM_ELEMENT_HANDLING||{},f.CUSTOM_ELEMENT_HANDLING&&yi(f.CUSTOM_ELEMENT_HANDLING.tagNameCheck)&&(D.tagNameCheck=f.CUSTOM_ELEMENT_HANDLING.tagNameCheck),f.CUSTOM_ELEMENT_HANDLING&&yi(f.CUSTOM_ELEMENT_HANDLING.attributeNameCheck)&&(D.attributeNameCheck=f.CUSTOM_ELEMENT_HANDLING.attributeNameCheck),f.CUSTOM_ELEMENT_HANDLING&&typeof f.CUSTOM_ELEMENT_HANDLING.allowCustomizedBuiltInElements=="boolean"&&(D.allowCustomizedBuiltInElements=f.CUSTOM_ELEMENT_HANDLING.allowCustomizedBuiltInElements),Ke&&(An=!1),Ct&&(He=!0),ze&&(K=L({},ro),z=[],ze.html===!0&&(L(K,ao),L(z,lo)),ze.svg===!0&&(L(K,Wn),L(z,Yn),L(z,Ft)),ze.svgFilters===!0&&(L(K,Vn),L(z,Yn),L(z,Ft)),ze.mathMl===!0&&(L(K,Gn),L(z,co),L(z,Ft))),f.ADD_TAGS&&(typeof f.ADD_TAGS=="function"?Ue.tagCheck=f.ADD_TAGS:(K===ci&&(K=ce(K)),L(K,f.ADD_TAGS,U))),f.ADD_ATTR&&(typeof f.ADD_ATTR=="function"?Ue.attributeCheck=f.ADD_ATTR:(z===di&&(z=ce(z)),L(z,f.ADD_ATTR,U))),f.ADD_URI_SAFE_ATTR&&L(Cn,f.ADD_URI_SAFE_ATTR,U),f.FORBID_CONTENTS&&(ae===En&&(ae=ce(ae)),L(ae,f.FORBID_CONTENTS,U)),f.ADD_FORBID_CONTENTS&&(ae===En&&(ae=ce(ae)),L(ae,f.ADD_FORBID_CONTENTS,U)),Tn&&(K["#text"]=!0),Te&&L(K,["html","head","body"]),K.table&&(L(K,["tbody"]),delete nt.tbody),f.TRUSTED_TYPES_POLICY){if(typeof f.TRUSTED_TYPES_POLICY.createHTML!="function")throw ct('TRUSTED_TYPES_POLICY configuration option must provide a "createHTML" hook.');if(typeof f.TRUSTED_TYPES_POLICY.createScriptURL!="function")throw ct('TRUSTED_TYPES_POLICY configuration option must provide a "createScriptURL" hook.');C=f.TRUSTED_TYPES_POLICY,A=C.createHTML("")}else C===void 0&&(C=Bd(v,i)),C!==null&&typeof A=="string"&&(A=C.createHTML(""));Q&&Q(f),qe=f}},wi=L({},[...Wn,...Vn,...Td]),$i=L({},[...Gn,...Ed]),Cr=function(f){let k=R(f);(!k||!k.tagName)&&(k={namespaceURI:je,tagName:"template"});const _=qt(f.tagName),N=qt(k.tagName);return Ln[f.namespaceURI]?f.namespaceURI===Rt?k.namespaceURI===pe?_==="svg":k.namespaceURI===Lt?_==="svg"&&(N==="annotation-xml"||Mt[N]):!!wi[_]:f.namespaceURI===Lt?k.namespaceURI===pe?_==="math":k.namespaceURI===Rt?_==="math"&&Pt[N]:!!$i[_]:f.namespaceURI===pe?k.namespaceURI===Rt&&!Pt[N]||k.namespaceURI===Lt&&!Mt[N]?!1:!$i[_]&&(Sr[_]||!wi[_]):!!(it==="application/xhtml+xml"&&Ln[f.namespaceURI]):!1},re=function(f){rt(t.removed,{element:f});try{R(f).removeChild(f)}catch{x(f)}},Ee=function(f,k){try{rt(t.removed,{attribute:k.getAttributeNode(f),from:k})}catch{rt(t.removed,{attribute:null,from:k})}if(k.removeAttribute(f),f==="is")if(He||Ct)try{re(k)}catch{}else try{k.setAttribute(f,"")}catch{}},ki=function(f){let k=null,_=null;if(_n)f="<remove></remove>"+f;else{const F=qn(f,/^[\r\n\t ]+/);_=F&&F[0]}it==="application/xhtml+xml"&&je===pe&&(f='<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>'+f+"</body></html>");const N=C?C.createHTML(f):f;if(je===pe)try{k=new h().parseFromString(N,it)}catch{}if(!k||!k.documentElement){k=B.createDocument(je,"template",null);try{k.documentElement.innerHTML=In?A:N}catch{}}const q=k.body||k.documentElement;return f&&_&&q.insertBefore(n.createTextNode(_),q.childNodes[0]||null),je===pe?yn.call(k,Te?"html":"body")[0]:Te?k.documentElement:q},xi=function(f){return ue.call(f.ownerDocument||f,f,p.SHOW_ELEMENT|p.SHOW_COMMENT|p.SHOW_TEXT|p.SHOW_PROCESSING_INSTRUCTION|p.SHOW_CDATA_SECTION,null)},Mn=function(f){return f instanceof u&&(typeof f.nodeName!="string"||typeof f.textContent!="string"||typeof f.removeChild!="function"||!(f.attributes instanceof l)||typeof f.removeAttribute!="function"||typeof f.setAttribute!="function"||typeof f.namespaceURI!="string"||typeof f.insertBefore!="function"||typeof f.hasChildNodes!="function")},Ai=function(f){return typeof c=="function"&&f instanceof c};function fe(T,f,k){Bt(T,_=>{_.call(t,f,k,qe)})}const Si=function(f){let k=null;if(fe(V.beforeSanitizeElements,f,null),Mn(f))return re(f),!0;const _=U(f.nodeName);if(fe(V.uponSanitizeElement,f,{tagName:_,allowedTags:K}),Et&&f.hasChildNodes()&&!Ai(f.firstElementChild)&&G(/<[/\w!]/g,f.innerHTML)&&G(/<[/\w!]/g,f.textContent)||f.nodeType===ut.progressingInstruction||Et&&f.nodeType===ut.comment&&G(/<[/\w]/g,f.data))return re(f),!0;if(!(Ue.tagCheck instanceof Function&&Ue.tagCheck(_))&&(!K[_]||nt[_])){if(!nt[_]&&Ti(_)&&(D.tagNameCheck instanceof RegExp&&G(D.tagNameCheck,_)||D.tagNameCheck instanceof Function&&D.tagNameCheck(_)))return!1;if(Tn&&!ae[_]){const N=R(f)||f.parentNode,q=I(f)||f.childNodes;if(q&&N){const F=q.length;for(let Z=F-1;Z>=0;--Z){const he=$(q[Z],!0);he.__removalCount=(f.__removalCount||0)+1,N.insertBefore(he,E(f))}}}return re(f),!0}return f instanceof r&&!Cr(f)||(_==="noscript"||_==="noembed"||_==="noframes")&&G(/<\/no(script|embed|frames)/i,f.innerHTML)?(re(f),!0):(Ke&&f.nodeType===ut.text&&(k=f.textContent,Bt([wn,$n,kn],N=>{k=lt(k,N," ")}),f.textContent!==k&&(rt(t.removed,{element:f.cloneNode()}),f.textContent=k)),fe(V.afterSanitizeElements,f,null),!1)},_i=function(f,k,_){if(hi&&(k==="id"||k==="name")&&(_ in n||_ in Er))return!1;if(!(An&&!xn[k]&&G(yr,k))){if(!(ui&&G(wr,k))){if(!(Ue.attributeCheck instanceof Function&&Ue.attributeCheck(k,f))){if(!z[k]||xn[k]){if(!(Ti(f)&&(D.tagNameCheck instanceof RegExp&&G(D.tagNameCheck,f)||D.tagNameCheck instanceof Function&&D.tagNameCheck(f))&&(D.attributeNameCheck instanceof RegExp&&G(D.attributeNameCheck,k)||D.attributeNameCheck instanceof Function&&D.attributeNameCheck(k,f))||k==="is"&&D.allowCustomizedBuiltInElements&&(D.tagNameCheck instanceof RegExp&&G(D.tagNameCheck,_)||D.tagNameCheck instanceof Function&&D.tagNameCheck(_))))return!1}else if(!Cn[k]){if(!G(li,lt(_,ri,""))){if(!((k==="src"||k==="xlink:href"||k==="href")&&f!=="script"&&xd(_,"data:")===0&&vi[f])){if(!(pi&&!G($r,lt(_,ri,"")))){if(_)return!1}}}}}}}return!0},Ti=function(f){return f!=="annotation-xml"&&qn(f,kr)},Ei=function(f){fe(V.beforeSanitizeAttributes,f,null);const{attributes:k}=f;if(!k||Mn(f))return;const _={attrName:"",attrValue:"",keepAttr:!0,allowedAttributes:z,forceKeepAttr:void 0};let N=k.length;for(;N--;){const q=k[N],{name:F,namespaceURI:Z,value:he}=q,We=U(F),Pn=he;let j=F==="value"?Pn:Ad(Pn);if(_.attrName=We,_.attrValue=j,_.keepAttr=!0,_.forceKeepAttr=void 0,fe(V.uponSanitizeAttribute,f,_),j=_.attrValue,gi&&(We==="id"||We==="name")&&(Ee(F,f),j=xr+j),Et&&G(/((--!?|])>)|<\/(style|title|textarea)/i,j)){Ee(F,f);continue}if(We==="attributename"&&qn(j,"href")){Ee(F,f);continue}if(_.forceKeepAttr)continue;if(!_.keepAttr){Ee(F,f);continue}if(!fi&&G(/\/>/i,j)){Ee(F,f);continue}Ke&&Bt([wn,$n,kn],Ii=>{j=lt(j,Ii," ")});const Ci=U(f.nodeName);if(!_i(Ci,We,j)){Ee(F,f);continue}if(C&&typeof v=="object"&&typeof v.getAttributeType=="function"&&!Z)switch(v.getAttributeType(Ci,We)){case"TrustedHTML":{j=C.createHTML(j);break}case"TrustedScriptURL":{j=C.createScriptURL(j);break}}if(j!==Pn)try{Z?f.setAttributeNS(Z,F,j):f.setAttribute(F,j),Mn(f)?re(f):oo(t.removed)}catch{Ee(F,f)}}fe(V.afterSanitizeAttributes,f,null)},Ir=function T(f){let k=null;const _=xi(f);for(fe(V.beforeSanitizeShadowDOM,f,null);k=_.nextNode();)fe(V.uponSanitizeShadowNode,k,null),Si(k),Ei(k),k.content instanceof o&&T(k.content);fe(V.afterSanitizeShadowDOM,f,null)};return t.sanitize=function(T){let f=arguments.length>1&&arguments[1]!==void 0?arguments[1]:{},k=null,_=null,N=null,q=null;if(In=!T,In&&(T="<!-->"),typeof T!="string"&&!Ai(T))if(typeof T.toString=="function"){if(T=T.toString(),typeof T!="string")throw ct("dirty is not a string, aborting")}else throw ct("toString is not a function");if(!t.isSupported)return T;if(Sn||Rn(f),t.removed=[],typeof T=="string"&&(st=!1),st){if(T.nodeName){const he=U(T.nodeName);if(!K[he]||nt[he])throw ct("root node is forbidden and cannot be sanitized in-place")}}else if(T instanceof c)k=ki("<!---->"),_=k.ownerDocument.importNode(T,!0),_.nodeType===ut.element&&_.nodeName==="BODY"||_.nodeName==="HTML"?k=_:k.appendChild(_);else{if(!He&&!Ke&&!Te&&T.indexOf("<")===-1)return C&&It?C.createHTML(T):T;if(k=ki(T),!k)return He?null:It?A:""}k&&_n&&re(k.firstChild);const F=xi(st?T:k);for(;N=F.nextNode();)Si(N),Ei(N),N.content instanceof o&&Ir(N.content);if(st)return T;if(He){if(Ct)for(q=bn.call(k.ownerDocument);k.firstChild;)q.appendChild(k.firstChild);else q=k;return(z.shadowroot||z.shadowrootmode)&&(q=br.call(s,q,!0)),q}let Z=Te?k.outerHTML:k.innerHTML;return Te&&K["!doctype"]&&k.ownerDocument&&k.ownerDocument.doctype&&k.ownerDocument.doctype.name&&G(Ha,k.ownerDocument.doctype.name)&&(Z="<!DOCTYPE "+k.ownerDocument.doctype.name+`>
`+Z),Ke&&Bt([wn,$n,kn],he=>{Z=lt(Z,he," ")}),C&&It?C.createHTML(Z):Z},t.setConfig=function(){let T=arguments.length>0&&arguments[0]!==void 0?arguments[0]:{};Rn(T),Sn=!0},t.clearConfig=function(){qe=null,Sn=!1},t.isValidAttribute=function(T,f,k){qe||Rn({});const _=U(T),N=U(f);return _i(_,N,k)},t.addHook=function(T,f){typeof f=="function"&&rt(V[T],f)},t.removeHook=function(T,f){if(f!==void 0){const k=$d(V[T],f);return k===-1?void 0:kd(V[T],k,1)[0]}return oo(V[T])},t.removeHooks=function(T){V[T]=[]},t.removeAllHooks=function(){V=po()},t}var vs=za();function Qs(){return{async:!1,breaks:!1,extensions:null,gfm:!0,hooks:null,pedantic:!1,renderer:null,silent:!1,tokenizer:null,walkTokens:null}}var Fe=Qs();function ja(e){Fe=e}var mt={exec:()=>null};function M(e,t=""){let n=typeof e=="string"?e:e.source,s={replace:(i,o)=>{let a=typeof o=="string"?o:o.source;return a=a.replace(Y.caret,"$1"),n=n.replace(i,a),s},getRegex:()=>new RegExp(n,t)};return s}var Fd=(()=>{try{return!!new RegExp("(?<=1)(?<!1)")}catch{return!1}})(),Y={codeRemoveIndent:/^(?: {1,4}| {0,3}\t)/gm,outputLinkReplace:/\\([\[\]])/g,indentCodeCompensation:/^(\s+)(?:```)/,beginningSpace:/^\s+/,endingHash:/#$/,startingSpaceChar:/^ /,endingSpaceChar:/ $/,nonSpaceChar:/[^ ]/,newLineCharGlobal:/\n/g,tabCharGlobal:/\t/g,multipleSpaceGlobal:/\s+/g,blankLine:/^[ \t]*$/,doubleBlankLine:/\n[ \t]*\n[ \t]*$/,blockquoteStart:/^ {0,3}>/,blockquoteSetextReplace:/\n {0,3}((?:=+|-+) *)(?=\n|$)/g,blockquoteSetextReplace2:/^ {0,3}>[ \t]?/gm,listReplaceTabs:/^\t+/,listReplaceNesting:/^ {1,4}(?=( {4})*[^ ])/g,listIsTask:/^\[[ xX]\] +\S/,listReplaceTask:/^\[[ xX]\] +/,listTaskCheckbox:/\[[ xX]\]/,anyLine:/\n.*\n/,hrefBrackets:/^<(.*)>$/,tableDelimiter:/[:|]/,tableAlignChars:/^\||\| *$/g,tableRowBlankLine:/\n[ \t]*$/,tableAlignRight:/^ *-+: *$/,tableAlignCenter:/^ *:-+: *$/,tableAlignLeft:/^ *:-+ *$/,startATag:/^<a /i,endATag:/^<\/a>/i,startPreScriptTag:/^<(pre|code|kbd|script)(\s|>)/i,endPreScriptTag:/^<\/(pre|code|kbd|script)(\s|>)/i,startAngleBracket:/^</,endAngleBracket:/>$/,pedanticHrefTitle:/^([^'"]*[^\s])\s+(['"])(.*)\2/,unicodeAlphaNumeric:/[\p{L}\p{N}]/u,escapeTest:/[&<>"']/,escapeReplace:/[&<>"']/g,escapeTestNoEncode:/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,escapeReplaceNoEncode:/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,unescapeTest:/&(#(?:\d+)|(?:#x[0-9A-Fa-f]+)|(?:\w+));?/ig,caret:/(^|[^\[])\^/g,percentDecode:/%25/g,findPipe:/\|/g,splitPipe:/ \|/,slashPipe:/\\\|/g,carriageReturn:/\r\n|\r/g,spaceLine:/^ +$/gm,notSpaceStart:/^\S*/,endingNewline:/\n$/,listItemRegex:e=>new RegExp(`^( {0,3}${e})((?:[	 ][^\\n]*)?(?:\\n|$))`),nextBulletRegex:e=>new RegExp(`^ {0,${Math.min(3,e-1)}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`),hrRegex:e=>new RegExp(`^ {0,${Math.min(3,e-1)}}((?:- *){3,}|(?:_ *){3,}|(?:\\* *){3,})(?:\\n+|$)`),fencesBeginRegex:e=>new RegExp(`^ {0,${Math.min(3,e-1)}}(?:\`\`\`|~~~)`),headingBeginRegex:e=>new RegExp(`^ {0,${Math.min(3,e-1)}}#`),htmlBeginRegex:e=>new RegExp(`^ {0,${Math.min(3,e-1)}}<(?:[a-z].*>|!--)`,"i")},Ud=/^(?:[ \t]*(?:\n|$))+/,Kd=/^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,Hd=/^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/,Tt=/^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,zd=/^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,Js=/(?:[*+-]|\d{1,9}[.)])/,qa=/^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |blockCode|fences|blockquote|heading|html|table))+?)\n {0,3}(=+|-+) *(?:\n+|$)/,Wa=M(qa).replace(/bull/g,Js).replace(/blockCode/g,/(?: {4}| {0,3}\t)/).replace(/fences/g,/ {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g,/ {0,3}>/).replace(/heading/g,/ {0,3}#{1,6}/).replace(/html/g,/ {0,3}<[^\n>]+>\n/).replace(/\|table/g,"").getRegex(),jd=M(qa).replace(/bull/g,Js).replace(/blockCode/g,/(?: {4}| {0,3}\t)/).replace(/fences/g,/ {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g,/ {0,3}>/).replace(/heading/g,/ {0,3}#{1,6}/).replace(/html/g,/ {0,3}<[^\n>]+>\n/).replace(/table/g,/ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex(),Zs=/^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table| +\n)[^\n]+)*)/,qd=/^[^\n]+/,Xs=/(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+/,Wd=M(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace("label",Xs).replace("title",/(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/).getRegex(),Vd=M(/^( {0,3}bull)([ \t][^\n]+?)?(?:\n|$)/).replace(/bull/g,Js).getRegex(),hn="address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul",ei=/<!--(?:-?>|[\s\S]*?(?:-->|$))/,Gd=M("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n+|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>\\n*|$)|<![A-Z][\\s\\S]*?(?:>\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>\\n*|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|<(?!script|pre|style|textarea)([a-z][\\w-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|</(?!script|pre|style|textarea)[a-z][\\w-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))","i").replace("comment",ei).replace("tag",hn).replace("attribute",/ +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex(),Va=M(Zs).replace("hr",Tt).replace("heading"," {0,3}#{1,6}(?:\\s|$)").replace("|lheading","").replace("|table","").replace("blockquote"," {0,3}>").replace("fences"," {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list"," {0,3}(?:[*+-]|1[.)]) ").replace("html","</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag",hn).getRegex(),Yd=M(/^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/).replace("paragraph",Va).getRegex(),ti={blockquote:Yd,code:Kd,def:Wd,fences:Hd,heading:zd,hr:Tt,html:Gd,lheading:Wa,list:Vd,newline:Ud,paragraph:Va,table:mt,text:qd},fo=M("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)").replace("hr",Tt).replace("heading"," {0,3}#{1,6}(?:\\s|$)").replace("blockquote"," {0,3}>").replace("code","(?: {4}| {0,3}	)[^\\n]").replace("fences"," {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list"," {0,3}(?:[*+-]|1[.)]) ").replace("html","</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag",hn).getRegex(),Qd={...ti,lheading:jd,table:fo,paragraph:M(Zs).replace("hr",Tt).replace("heading"," {0,3}#{1,6}(?:\\s|$)").replace("|lheading","").replace("table",fo).replace("blockquote"," {0,3}>").replace("fences"," {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list"," {0,3}(?:[*+-]|1[.)]) ").replace("html","</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag",hn).getRegex()},Jd={...ti,html:M(`^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`).replace("comment",ei).replace(/tag/g,"(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b").getRegex(),def:/^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/,heading:/^(#{1,6})(.*)(?:\n+|$)/,fences:mt,lheading:/^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/,paragraph:M(Zs).replace("hr",Tt).replace("heading",` *#{1,6} *[^
]`).replace("lheading",Wa).replace("|table","").replace("blockquote"," {0,3}>").replace("|fences","").replace("|list","").replace("|html","").replace("|tag","").getRegex()},Zd=/^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,Xd=/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,Ga=/^( {2,}|\\)\n(?!\s*$)/,eu=/^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/,gn=/[\p{P}\p{S}]/u,ni=/[\s\p{P}\p{S}]/u,Ya=/[^\s\p{P}\p{S}]/u,tu=M(/^((?![*_])punctSpace)/,"u").replace(/punctSpace/g,ni).getRegex(),Qa=/(?!~)[\p{P}\p{S}]/u,nu=/(?!~)[\s\p{P}\p{S}]/u,su=/(?:[^\s\p{P}\p{S}]|~)/u,iu=M(/link|precode-code|html/,"g").replace("link",/\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/).replace("precode-",Fd?"(?<!`)()":"(^^|[^`])").replace("code",/(?<b>`+)[^`]+\k<b>(?!`)/).replace("html",/<(?! )[^<>]*?>/).getRegex(),Ja=/^(?:\*+(?:((?!\*)punct)|[^\s*]))|^_+(?:((?!_)punct)|([^\s_]))/,ou=M(Ja,"u").replace(/punct/g,gn).getRegex(),au=M(Ja,"u").replace(/punct/g,Qa).getRegex(),Za="^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)",ru=M(Za,"gu").replace(/notPunctSpace/g,Ya).replace(/punctSpace/g,ni).replace(/punct/g,gn).getRegex(),lu=M(Za,"gu").replace(/notPunctSpace/g,su).replace(/punctSpace/g,nu).replace(/punct/g,Qa).getRegex(),cu=M("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)","gu").replace(/notPunctSpace/g,Ya).replace(/punctSpace/g,ni).replace(/punct/g,gn).getRegex(),du=M(/\\(punct)/,"gu").replace(/punct/g,gn).getRegex(),uu=M(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace("scheme",/[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace("email",/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex(),pu=M(ei).replace("(?:-->|$)","-->").getRegex(),fu=M("^comment|^</[a-zA-Z][\\w:-]*\\s*>|^<[a-zA-Z][\\w-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>").replace("comment",pu).replace("attribute",/\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex(),Jt=/(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+[^`]*?`+(?!`)|[^\[\]\\`])*?/,hu=M(/^!?\[(label)\]\(\s*(href)(?:(?:[ \t]*(?:\n[ \t]*)?)(title))?\s*\)/).replace("label",Jt).replace("href",/<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]*/).replace("title",/"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/).getRegex(),Xa=M(/^!?\[(label)\]\[(ref)\]/).replace("label",Jt).replace("ref",Xs).getRegex(),er=M(/^!?\[(ref)\](?:\[\])?/).replace("ref",Xs).getRegex(),gu=M("reflink|nolink(?!\\()","g").replace("reflink",Xa).replace("nolink",er).getRegex(),ho=/[hH][tT][tT][pP][sS]?|[fF][tT][pP]/,si={_backpedal:mt,anyPunctuation:du,autolink:uu,blockSkip:iu,br:Ga,code:Xd,del:mt,emStrongLDelim:ou,emStrongRDelimAst:ru,emStrongRDelimUnd:cu,escape:Zd,link:hu,nolink:er,punctuation:tu,reflink:Xa,reflinkSearch:gu,tag:fu,text:eu,url:mt},vu={...si,link:M(/^!?\[(label)\]\((.*?)\)/).replace("label",Jt).getRegex(),reflink:M(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace("label",Jt).getRegex()},ms={...si,emStrongRDelimAst:lu,emStrongLDelim:au,url:M(/^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/).replace("protocol",ho).replace("email",/[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/).getRegex(),_backpedal:/(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,del:/^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,text:M(/^([`~]+|[^`~])(?:(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)))/).replace("protocol",ho).getRegex()},mu={...ms,br:M(Ga).replace("{2,}","*").getRegex(),text:M(ms.text).replace("\\b_","\\b_| {2,}\\n").replace(/\{2,\}/g,"*").getRegex()},Ut={normal:ti,gfm:Qd,pedantic:Jd},pt={normal:si,gfm:ms,breaks:mu,pedantic:vu},bu={"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"},go=e=>bu[e];function ve(e,t){if(t){if(Y.escapeTest.test(e))return e.replace(Y.escapeReplace,go)}else if(Y.escapeTestNoEncode.test(e))return e.replace(Y.escapeReplaceNoEncode,go);return e}function vo(e){try{e=encodeURI(e).replace(Y.percentDecode,"%")}catch{return null}return e}function mo(e,t){let n=e.replace(Y.findPipe,(o,a,c)=>{let r=!1,p=a;for(;--p>=0&&c[p]==="\\";)r=!r;return r?"|":" |"}),s=n.split(Y.splitPipe),i=0;if(s[0].trim()||s.shift(),s.length>0&&!s.at(-1)?.trim()&&s.pop(),t)if(s.length>t)s.splice(t);else for(;s.length<t;)s.push("");for(;i<s.length;i++)s[i]=s[i].trim().replace(Y.slashPipe,"|");return s}function ft(e,t,n){let s=e.length;if(s===0)return"";let i=0;for(;i<s&&e.charAt(s-i-1)===t;)i++;return e.slice(0,s-i)}function yu(e,t){if(e.indexOf(t[1])===-1)return-1;let n=0;for(let s=0;s<e.length;s++)if(e[s]==="\\")s++;else if(e[s]===t[0])n++;else if(e[s]===t[1]&&(n--,n<0))return s;return n>0?-2:-1}function bo(e,t,n,s,i){let o=t.href,a=t.title||null,c=e[1].replace(i.other.outputLinkReplace,"$1");s.state.inLink=!0;let r={type:e[0].charAt(0)==="!"?"image":"link",raw:n,href:o,title:a,text:c,tokens:s.inlineTokens(c)};return s.state.inLink=!1,r}function wu(e,t,n){let s=e.match(n.other.indentCodeCompensation);if(s===null)return t;let i=s[1];return t.split(`
`).map(o=>{let a=o.match(n.other.beginningSpace);if(a===null)return o;let[c]=a;return c.length>=i.length?o.slice(i.length):o}).join(`
`)}var Zt=class{options;rules;lexer;constructor(e){this.options=e||Fe}space(e){let t=this.rules.block.newline.exec(e);if(t&&t[0].length>0)return{type:"space",raw:t[0]}}code(e){let t=this.rules.block.code.exec(e);if(t){let n=t[0].replace(this.rules.other.codeRemoveIndent,"");return{type:"code",raw:t[0],codeBlockStyle:"indented",text:this.options.pedantic?n:ft(n,`
`)}}}fences(e){let t=this.rules.block.fences.exec(e);if(t){let n=t[0],s=wu(n,t[3]||"",this.rules);return{type:"code",raw:n,lang:t[2]?t[2].trim().replace(this.rules.inline.anyPunctuation,"$1"):t[2],text:s}}}heading(e){let t=this.rules.block.heading.exec(e);if(t){let n=t[2].trim();if(this.rules.other.endingHash.test(n)){let s=ft(n,"#");(this.options.pedantic||!s||this.rules.other.endingSpaceChar.test(s))&&(n=s.trim())}return{type:"heading",raw:t[0],depth:t[1].length,text:n,tokens:this.lexer.inline(n)}}}hr(e){let t=this.rules.block.hr.exec(e);if(t)return{type:"hr",raw:ft(t[0],`
`)}}blockquote(e){let t=this.rules.block.blockquote.exec(e);if(t){let n=ft(t[0],`
`).split(`
`),s="",i="",o=[];for(;n.length>0;){let a=!1,c=[],r;for(r=0;r<n.length;r++)if(this.rules.other.blockquoteStart.test(n[r]))c.push(n[r]),a=!0;else if(!a)c.push(n[r]);else break;n=n.slice(r);let p=c.join(`
`),l=p.replace(this.rules.other.blockquoteSetextReplace,`
    $1`).replace(this.rules.other.blockquoteSetextReplace2,"");s=s?`${s}
${p}`:p,i=i?`${i}
${l}`:l;let u=this.lexer.state.top;if(this.lexer.state.top=!0,this.lexer.blockTokens(l,o,!0),this.lexer.state.top=u,n.length===0)break;let h=o.at(-1);if(h?.type==="code")break;if(h?.type==="blockquote"){let v=h,w=v.raw+`
`+n.join(`
`),$=this.blockquote(w);o[o.length-1]=$,s=s.substring(0,s.length-v.raw.length)+$.raw,i=i.substring(0,i.length-v.text.length)+$.text;break}else if(h?.type==="list"){let v=h,w=v.raw+`
`+n.join(`
`),$=this.list(w);o[o.length-1]=$,s=s.substring(0,s.length-h.raw.length)+$.raw,i=i.substring(0,i.length-v.raw.length)+$.raw,n=w.substring(o.at(-1).raw.length).split(`
`);continue}}return{type:"blockquote",raw:s,tokens:o,text:i}}}list(e){let t=this.rules.block.list.exec(e);if(t){let n=t[1].trim(),s=n.length>1,i={type:"list",raw:"",ordered:s,start:s?+n.slice(0,-1):"",loose:!1,items:[]};n=s?`\\d{1,9}\\${n.slice(-1)}`:`\\${n}`,this.options.pedantic&&(n=s?n:"[*+-]");let o=this.rules.other.listItemRegex(n),a=!1;for(;e;){let r=!1,p="",l="";if(!(t=o.exec(e))||this.rules.block.hr.test(e))break;p=t[0],e=e.substring(p.length);let u=t[2].split(`
`,1)[0].replace(this.rules.other.listReplaceTabs,$=>" ".repeat(3*$.length)),h=e.split(`
`,1)[0],v=!u.trim(),w=0;if(this.options.pedantic?(w=2,l=u.trimStart()):v?w=t[1].length+1:(w=t[2].search(this.rules.other.nonSpaceChar),w=w>4?1:w,l=u.slice(w),w+=t[1].length),v&&this.rules.other.blankLine.test(h)&&(p+=h+`
`,e=e.substring(h.length+1),r=!0),!r){let $=this.rules.other.nextBulletRegex(w),x=this.rules.other.hrRegex(w),E=this.rules.other.fencesBeginRegex(w),I=this.rules.other.headingBeginRegex(w),R=this.rules.other.htmlBeginRegex(w);for(;e;){let C=e.split(`
`,1)[0],A;if(h=C,this.options.pedantic?(h=h.replace(this.rules.other.listReplaceNesting,"  "),A=h):A=h.replace(this.rules.other.tabCharGlobal,"    "),E.test(h)||I.test(h)||R.test(h)||$.test(h)||x.test(h))break;if(A.search(this.rules.other.nonSpaceChar)>=w||!h.trim())l+=`
`+A.slice(w);else{if(v||u.replace(this.rules.other.tabCharGlobal,"    ").search(this.rules.other.nonSpaceChar)>=4||E.test(u)||I.test(u)||x.test(u))break;l+=`
`+h}!v&&!h.trim()&&(v=!0),p+=C+`
`,e=e.substring(C.length+1),u=A.slice(w)}}i.loose||(a?i.loose=!0:this.rules.other.doubleBlankLine.test(p)&&(a=!0)),i.items.push({type:"list_item",raw:p,task:!!this.options.gfm&&this.rules.other.listIsTask.test(l),loose:!1,text:l,tokens:[]}),i.raw+=p}let c=i.items.at(-1);if(c)c.raw=c.raw.trimEnd(),c.text=c.text.trimEnd();else return;i.raw=i.raw.trimEnd();for(let r of i.items){if(this.lexer.state.top=!1,r.tokens=this.lexer.blockTokens(r.text,[]),r.task){if(r.text=r.text.replace(this.rules.other.listReplaceTask,""),r.tokens[0]?.type==="text"||r.tokens[0]?.type==="paragraph"){r.tokens[0].raw=r.tokens[0].raw.replace(this.rules.other.listReplaceTask,""),r.tokens[0].text=r.tokens[0].text.replace(this.rules.other.listReplaceTask,"");for(let l=this.lexer.inlineQueue.length-1;l>=0;l--)if(this.rules.other.listIsTask.test(this.lexer.inlineQueue[l].src)){this.lexer.inlineQueue[l].src=this.lexer.inlineQueue[l].src.replace(this.rules.other.listReplaceTask,"");break}}let p=this.rules.other.listTaskCheckbox.exec(r.raw);if(p){let l={type:"checkbox",raw:p[0]+" ",checked:p[0]!=="[ ]"};r.checked=l.checked,i.loose?r.tokens[0]&&["paragraph","text"].includes(r.tokens[0].type)&&"tokens"in r.tokens[0]&&r.tokens[0].tokens?(r.tokens[0].raw=l.raw+r.tokens[0].raw,r.tokens[0].text=l.raw+r.tokens[0].text,r.tokens[0].tokens.unshift(l)):r.tokens.unshift({type:"paragraph",raw:l.raw,text:l.raw,tokens:[l]}):r.tokens.unshift(l)}}if(!i.loose){let p=r.tokens.filter(u=>u.type==="space"),l=p.length>0&&p.some(u=>this.rules.other.anyLine.test(u.raw));i.loose=l}}if(i.loose)for(let r of i.items){r.loose=!0;for(let p of r.tokens)p.type==="text"&&(p.type="paragraph")}return i}}html(e){let t=this.rules.block.html.exec(e);if(t)return{type:"html",block:!0,raw:t[0],pre:t[1]==="pre"||t[1]==="script"||t[1]==="style",text:t[0]}}def(e){let t=this.rules.block.def.exec(e);if(t){let n=t[1].toLowerCase().replace(this.rules.other.multipleSpaceGlobal," "),s=t[2]?t[2].replace(this.rules.other.hrefBrackets,"$1").replace(this.rules.inline.anyPunctuation,"$1"):"",i=t[3]?t[3].substring(1,t[3].length-1).replace(this.rules.inline.anyPunctuation,"$1"):t[3];return{type:"def",tag:n,raw:t[0],href:s,title:i}}}table(e){let t=this.rules.block.table.exec(e);if(!t||!this.rules.other.tableDelimiter.test(t[2]))return;let n=mo(t[1]),s=t[2].replace(this.rules.other.tableAlignChars,"").split("|"),i=t[3]?.trim()?t[3].replace(this.rules.other.tableRowBlankLine,"").split(`
`):[],o={type:"table",raw:t[0],header:[],align:[],rows:[]};if(n.length===s.length){for(let a of s)this.rules.other.tableAlignRight.test(a)?o.align.push("right"):this.rules.other.tableAlignCenter.test(a)?o.align.push("center"):this.rules.other.tableAlignLeft.test(a)?o.align.push("left"):o.align.push(null);for(let a=0;a<n.length;a++)o.header.push({text:n[a],tokens:this.lexer.inline(n[a]),header:!0,align:o.align[a]});for(let a of i)o.rows.push(mo(a,o.header.length).map((c,r)=>({text:c,tokens:this.lexer.inline(c),header:!1,align:o.align[r]})));return o}}lheading(e){let t=this.rules.block.lheading.exec(e);if(t)return{type:"heading",raw:t[0],depth:t[2].charAt(0)==="="?1:2,text:t[1],tokens:this.lexer.inline(t[1])}}paragraph(e){let t=this.rules.block.paragraph.exec(e);if(t){let n=t[1].charAt(t[1].length-1)===`
`?t[1].slice(0,-1):t[1];return{type:"paragraph",raw:t[0],text:n,tokens:this.lexer.inline(n)}}}text(e){let t=this.rules.block.text.exec(e);if(t)return{type:"text",raw:t[0],text:t[0],tokens:this.lexer.inline(t[0])}}escape(e){let t=this.rules.inline.escape.exec(e);if(t)return{type:"escape",raw:t[0],text:t[1]}}tag(e){let t=this.rules.inline.tag.exec(e);if(t)return!this.lexer.state.inLink&&this.rules.other.startATag.test(t[0])?this.lexer.state.inLink=!0:this.lexer.state.inLink&&this.rules.other.endATag.test(t[0])&&(this.lexer.state.inLink=!1),!this.lexer.state.inRawBlock&&this.rules.other.startPreScriptTag.test(t[0])?this.lexer.state.inRawBlock=!0:this.lexer.state.inRawBlock&&this.rules.other.endPreScriptTag.test(t[0])&&(this.lexer.state.inRawBlock=!1),{type:"html",raw:t[0],inLink:this.lexer.state.inLink,inRawBlock:this.lexer.state.inRawBlock,block:!1,text:t[0]}}link(e){let t=this.rules.inline.link.exec(e);if(t){let n=t[2].trim();if(!this.options.pedantic&&this.rules.other.startAngleBracket.test(n)){if(!this.rules.other.endAngleBracket.test(n))return;let o=ft(n.slice(0,-1),"\\");if((n.length-o.length)%2===0)return}else{let o=yu(t[2],"()");if(o===-2)return;if(o>-1){let a=(t[0].indexOf("!")===0?5:4)+t[1].length+o;t[2]=t[2].substring(0,o),t[0]=t[0].substring(0,a).trim(),t[3]=""}}let s=t[2],i="";if(this.options.pedantic){let o=this.rules.other.pedanticHrefTitle.exec(s);o&&(s=o[1],i=o[3])}else i=t[3]?t[3].slice(1,-1):"";return s=s.trim(),this.rules.other.startAngleBracket.test(s)&&(this.options.pedantic&&!this.rules.other.endAngleBracket.test(n)?s=s.slice(1):s=s.slice(1,-1)),bo(t,{href:s&&s.replace(this.rules.inline.anyPunctuation,"$1"),title:i&&i.replace(this.rules.inline.anyPunctuation,"$1")},t[0],this.lexer,this.rules)}}reflink(e,t){let n;if((n=this.rules.inline.reflink.exec(e))||(n=this.rules.inline.nolink.exec(e))){let s=(n[2]||n[1]).replace(this.rules.other.multipleSpaceGlobal," "),i=t[s.toLowerCase()];if(!i){let o=n[0].charAt(0);return{type:"text",raw:o,text:o}}return bo(n,i,n[0],this.lexer,this.rules)}}emStrong(e,t,n=""){let s=this.rules.inline.emStrongLDelim.exec(e);if(!(!s||s[3]&&n.match(this.rules.other.unicodeAlphaNumeric))&&(!(s[1]||s[2])||!n||this.rules.inline.punctuation.exec(n))){let i=[...s[0]].length-1,o,a,c=i,r=0,p=s[0][0]==="*"?this.rules.inline.emStrongRDelimAst:this.rules.inline.emStrongRDelimUnd;for(p.lastIndex=0,t=t.slice(-1*e.length+i);(s=p.exec(t))!=null;){if(o=s[1]||s[2]||s[3]||s[4]||s[5]||s[6],!o)continue;if(a=[...o].length,s[3]||s[4]){c+=a;continue}else if((s[5]||s[6])&&i%3&&!((i+a)%3)){r+=a;continue}if(c-=a,c>0)continue;a=Math.min(a,a+c+r);let l=[...s[0]][0].length,u=e.slice(0,i+s.index+l+a);if(Math.min(i,a)%2){let v=u.slice(1,-1);return{type:"em",raw:u,text:v,tokens:this.lexer.inlineTokens(v)}}let h=u.slice(2,-2);return{type:"strong",raw:u,text:h,tokens:this.lexer.inlineTokens(h)}}}}codespan(e){let t=this.rules.inline.code.exec(e);if(t){let n=t[2].replace(this.rules.other.newLineCharGlobal," "),s=this.rules.other.nonSpaceChar.test(n),i=this.rules.other.startingSpaceChar.test(n)&&this.rules.other.endingSpaceChar.test(n);return s&&i&&(n=n.substring(1,n.length-1)),{type:"codespan",raw:t[0],text:n}}}br(e){let t=this.rules.inline.br.exec(e);if(t)return{type:"br",raw:t[0]}}del(e){let t=this.rules.inline.del.exec(e);if(t)return{type:"del",raw:t[0],text:t[2],tokens:this.lexer.inlineTokens(t[2])}}autolink(e){let t=this.rules.inline.autolink.exec(e);if(t){let n,s;return t[2]==="@"?(n=t[1],s="mailto:"+n):(n=t[1],s=n),{type:"link",raw:t[0],text:n,href:s,tokens:[{type:"text",raw:n,text:n}]}}}url(e){let t;if(t=this.rules.inline.url.exec(e)){let n,s;if(t[2]==="@")n=t[0],s="mailto:"+n;else{let i;do i=t[0],t[0]=this.rules.inline._backpedal.exec(t[0])?.[0]??"";while(i!==t[0]);n=t[0],t[1]==="www."?s="http://"+t[0]:s=t[0]}return{type:"link",raw:t[0],text:n,href:s,tokens:[{type:"text",raw:n,text:n}]}}}inlineText(e){let t=this.rules.inline.text.exec(e);if(t){let n=this.lexer.state.inRawBlock;return{type:"text",raw:t[0],text:t[0],escaped:n}}}},se=class bs{tokens;options;state;inlineQueue;tokenizer;constructor(t){this.tokens=[],this.tokens.links=Object.create(null),this.options=t||Fe,this.options.tokenizer=this.options.tokenizer||new Zt,this.tokenizer=this.options.tokenizer,this.tokenizer.options=this.options,this.tokenizer.lexer=this,this.inlineQueue=[],this.state={inLink:!1,inRawBlock:!1,top:!0};let n={other:Y,block:Ut.normal,inline:pt.normal};this.options.pedantic?(n.block=Ut.pedantic,n.inline=pt.pedantic):this.options.gfm&&(n.block=Ut.gfm,this.options.breaks?n.inline=pt.breaks:n.inline=pt.gfm),this.tokenizer.rules=n}static get rules(){return{block:Ut,inline:pt}}static lex(t,n){return new bs(n).lex(t)}static lexInline(t,n){return new bs(n).inlineTokens(t)}lex(t){t=t.replace(Y.carriageReturn,`
`),this.blockTokens(t,this.tokens);for(let n=0;n<this.inlineQueue.length;n++){let s=this.inlineQueue[n];this.inlineTokens(s.src,s.tokens)}return this.inlineQueue=[],this.tokens}blockTokens(t,n=[],s=!1){for(this.options.pedantic&&(t=t.replace(Y.tabCharGlobal,"    ").replace(Y.spaceLine,""));t;){let i;if(this.options.extensions?.block?.some(a=>(i=a.call({lexer:this},t,n))?(t=t.substring(i.raw.length),n.push(i),!0):!1))continue;if(i=this.tokenizer.space(t)){t=t.substring(i.raw.length);let a=n.at(-1);i.raw.length===1&&a!==void 0?a.raw+=`
`:n.push(i);continue}if(i=this.tokenizer.code(t)){t=t.substring(i.raw.length);let a=n.at(-1);a?.type==="paragraph"||a?.type==="text"?(a.raw+=(a.raw.endsWith(`
`)?"":`
`)+i.raw,a.text+=`
`+i.text,this.inlineQueue.at(-1).src=a.text):n.push(i);continue}if(i=this.tokenizer.fences(t)){t=t.substring(i.raw.length),n.push(i);continue}if(i=this.tokenizer.heading(t)){t=t.substring(i.raw.length),n.push(i);continue}if(i=this.tokenizer.hr(t)){t=t.substring(i.raw.length),n.push(i);continue}if(i=this.tokenizer.blockquote(t)){t=t.substring(i.raw.length),n.push(i);continue}if(i=this.tokenizer.list(t)){t=t.substring(i.raw.length),n.push(i);continue}if(i=this.tokenizer.html(t)){t=t.substring(i.raw.length),n.push(i);continue}if(i=this.tokenizer.def(t)){t=t.substring(i.raw.length);let a=n.at(-1);a?.type==="paragraph"||a?.type==="text"?(a.raw+=(a.raw.endsWith(`
`)?"":`
`)+i.raw,a.text+=`
`+i.raw,this.inlineQueue.at(-1).src=a.text):this.tokens.links[i.tag]||(this.tokens.links[i.tag]={href:i.href,title:i.title},n.push(i));continue}if(i=this.tokenizer.table(t)){t=t.substring(i.raw.length),n.push(i);continue}if(i=this.tokenizer.lheading(t)){t=t.substring(i.raw.length),n.push(i);continue}let o=t;if(this.options.extensions?.startBlock){let a=1/0,c=t.slice(1),r;this.options.extensions.startBlock.forEach(p=>{r=p.call({lexer:this},c),typeof r=="number"&&r>=0&&(a=Math.min(a,r))}),a<1/0&&a>=0&&(o=t.substring(0,a+1))}if(this.state.top&&(i=this.tokenizer.paragraph(o))){let a=n.at(-1);s&&a?.type==="paragraph"?(a.raw+=(a.raw.endsWith(`
`)?"":`
`)+i.raw,a.text+=`
`+i.text,this.inlineQueue.pop(),this.inlineQueue.at(-1).src=a.text):n.push(i),s=o.length!==t.length,t=t.substring(i.raw.length);continue}if(i=this.tokenizer.text(t)){t=t.substring(i.raw.length);let a=n.at(-1);a?.type==="text"?(a.raw+=(a.raw.endsWith(`
`)?"":`
`)+i.raw,a.text+=`
`+i.text,this.inlineQueue.pop(),this.inlineQueue.at(-1).src=a.text):n.push(i);continue}if(t){let a="Infinite loop on byte: "+t.charCodeAt(0);if(this.options.silent){console.error(a);break}else throw new Error(a)}}return this.state.top=!0,n}inline(t,n=[]){return this.inlineQueue.push({src:t,tokens:n}),n}inlineTokens(t,n=[]){let s=t,i=null;if(this.tokens.links){let r=Object.keys(this.tokens.links);if(r.length>0)for(;(i=this.tokenizer.rules.inline.reflinkSearch.exec(s))!=null;)r.includes(i[0].slice(i[0].lastIndexOf("[")+1,-1))&&(s=s.slice(0,i.index)+"["+"a".repeat(i[0].length-2)+"]"+s.slice(this.tokenizer.rules.inline.reflinkSearch.lastIndex))}for(;(i=this.tokenizer.rules.inline.anyPunctuation.exec(s))!=null;)s=s.slice(0,i.index)+"++"+s.slice(this.tokenizer.rules.inline.anyPunctuation.lastIndex);let o;for(;(i=this.tokenizer.rules.inline.blockSkip.exec(s))!=null;)o=i[2]?i[2].length:0,s=s.slice(0,i.index+o)+"["+"a".repeat(i[0].length-o-2)+"]"+s.slice(this.tokenizer.rules.inline.blockSkip.lastIndex);s=this.options.hooks?.emStrongMask?.call({lexer:this},s)??s;let a=!1,c="";for(;t;){a||(c=""),a=!1;let r;if(this.options.extensions?.inline?.some(l=>(r=l.call({lexer:this},t,n))?(t=t.substring(r.raw.length),n.push(r),!0):!1))continue;if(r=this.tokenizer.escape(t)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.tag(t)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.link(t)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.reflink(t,this.tokens.links)){t=t.substring(r.raw.length);let l=n.at(-1);r.type==="text"&&l?.type==="text"?(l.raw+=r.raw,l.text+=r.text):n.push(r);continue}if(r=this.tokenizer.emStrong(t,s,c)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.codespan(t)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.br(t)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.del(t)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.autolink(t)){t=t.substring(r.raw.length),n.push(r);continue}if(!this.state.inLink&&(r=this.tokenizer.url(t))){t=t.substring(r.raw.length),n.push(r);continue}let p=t;if(this.options.extensions?.startInline){let l=1/0,u=t.slice(1),h;this.options.extensions.startInline.forEach(v=>{h=v.call({lexer:this},u),typeof h=="number"&&h>=0&&(l=Math.min(l,h))}),l<1/0&&l>=0&&(p=t.substring(0,l+1))}if(r=this.tokenizer.inlineText(p)){t=t.substring(r.raw.length),r.raw.slice(-1)!=="_"&&(c=r.raw.slice(-1)),a=!0;let l=n.at(-1);l?.type==="text"?(l.raw+=r.raw,l.text+=r.text):n.push(r);continue}if(t){let l="Infinite loop on byte: "+t.charCodeAt(0);if(this.options.silent){console.error(l);break}else throw new Error(l)}}return n}},Xt=class{options;parser;constructor(e){this.options=e||Fe}space(e){return""}code({text:e,lang:t,escaped:n}){let s=(t||"").match(Y.notSpaceStart)?.[0],i=e.replace(Y.endingNewline,"")+`
`;return s?'<pre><code class="language-'+ve(s)+'">'+(n?i:ve(i,!0))+`</code></pre>
`:"<pre><code>"+(n?i:ve(i,!0))+`</code></pre>
`}blockquote({tokens:e}){return`<blockquote>
${this.parser.parse(e)}</blockquote>
`}html({text:e}){return e}def(e){return""}heading({tokens:e,depth:t}){return`<h${t}>${this.parser.parseInline(e)}</h${t}>
`}hr(e){return`<hr>
`}list(e){let t=e.ordered,n=e.start,s="";for(let a=0;a<e.items.length;a++){let c=e.items[a];s+=this.listitem(c)}let i=t?"ol":"ul",o=t&&n!==1?' start="'+n+'"':"";return"<"+i+o+`>
`+s+"</"+i+`>
`}listitem(e){return`<li>${this.parser.parse(e.tokens)}</li>
`}checkbox({checked:e}){return"<input "+(e?'checked="" ':"")+'disabled="" type="checkbox"> '}paragraph({tokens:e}){return`<p>${this.parser.parseInline(e)}</p>
`}table(e){let t="",n="";for(let i=0;i<e.header.length;i++)n+=this.tablecell(e.header[i]);t+=this.tablerow({text:n});let s="";for(let i=0;i<e.rows.length;i++){let o=e.rows[i];n="";for(let a=0;a<o.length;a++)n+=this.tablecell(o[a]);s+=this.tablerow({text:n})}return s&&(s=`<tbody>${s}</tbody>`),`<table>
<thead>
`+t+`</thead>
`+s+`</table>
`}tablerow({text:e}){return`<tr>
${e}</tr>
`}tablecell(e){let t=this.parser.parseInline(e.tokens),n=e.header?"th":"td";return(e.align?`<${n} align="${e.align}">`:`<${n}>`)+t+`</${n}>
`}strong({tokens:e}){return`<strong>${this.parser.parseInline(e)}</strong>`}em({tokens:e}){return`<em>${this.parser.parseInline(e)}</em>`}codespan({text:e}){return`<code>${ve(e,!0)}</code>`}br(e){return"<br>"}del({tokens:e}){return`<del>${this.parser.parseInline(e)}</del>`}link({href:e,title:t,tokens:n}){let s=this.parser.parseInline(n),i=vo(e);if(i===null)return s;e=i;let o='<a href="'+e+'"';return t&&(o+=' title="'+ve(t)+'"'),o+=">"+s+"</a>",o}image({href:e,title:t,text:n,tokens:s}){s&&(n=this.parser.parseInline(s,this.parser.textRenderer));let i=vo(e);if(i===null)return ve(n);e=i;let o=`<img src="${e}" alt="${n}"`;return t&&(o+=` title="${ve(t)}"`),o+=">",o}text(e){return"tokens"in e&&e.tokens?this.parser.parseInline(e.tokens):"escaped"in e&&e.escaped?e.text:ve(e.text)}},ii=class{strong({text:e}){return e}em({text:e}){return e}codespan({text:e}){return e}del({text:e}){return e}html({text:e}){return e}text({text:e}){return e}link({text:e}){return""+e}image({text:e}){return""+e}br(){return""}checkbox({raw:e}){return e}},ie=class ys{options;renderer;textRenderer;constructor(t){this.options=t||Fe,this.options.renderer=this.options.renderer||new Xt,this.renderer=this.options.renderer,this.renderer.options=this.options,this.renderer.parser=this,this.textRenderer=new ii}static parse(t,n){return new ys(n).parse(t)}static parseInline(t,n){return new ys(n).parseInline(t)}parse(t){let n="";for(let s=0;s<t.length;s++){let i=t[s];if(this.options.extensions?.renderers?.[i.type]){let a=i,c=this.options.extensions.renderers[a.type].call({parser:this},a);if(c!==!1||!["space","hr","heading","code","table","blockquote","list","html","def","paragraph","text"].includes(a.type)){n+=c||"";continue}}let o=i;switch(o.type){case"space":{n+=this.renderer.space(o);break}case"hr":{n+=this.renderer.hr(o);break}case"heading":{n+=this.renderer.heading(o);break}case"code":{n+=this.renderer.code(o);break}case"table":{n+=this.renderer.table(o);break}case"blockquote":{n+=this.renderer.blockquote(o);break}case"list":{n+=this.renderer.list(o);break}case"checkbox":{n+=this.renderer.checkbox(o);break}case"html":{n+=this.renderer.html(o);break}case"def":{n+=this.renderer.def(o);break}case"paragraph":{n+=this.renderer.paragraph(o);break}case"text":{n+=this.renderer.text(o);break}default:{let a='Token with "'+o.type+'" type was not found.';if(this.options.silent)return console.error(a),"";throw new Error(a)}}}return n}parseInline(t,n=this.renderer){let s="";for(let i=0;i<t.length;i++){let o=t[i];if(this.options.extensions?.renderers?.[o.type]){let c=this.options.extensions.renderers[o.type].call({parser:this},o);if(c!==!1||!["escape","html","link","image","strong","em","codespan","br","del","text"].includes(o.type)){s+=c||"";continue}}let a=o;switch(a.type){case"escape":{s+=n.text(a);break}case"html":{s+=n.html(a);break}case"link":{s+=n.link(a);break}case"image":{s+=n.image(a);break}case"checkbox":{s+=n.checkbox(a);break}case"strong":{s+=n.strong(a);break}case"em":{s+=n.em(a);break}case"codespan":{s+=n.codespan(a);break}case"br":{s+=n.br(a);break}case"del":{s+=n.del(a);break}case"text":{s+=n.text(a);break}default:{let c='Token with "'+a.type+'" type was not found.';if(this.options.silent)return console.error(c),"";throw new Error(c)}}}return s}},ht=class{options;block;constructor(e){this.options=e||Fe}static passThroughHooks=new Set(["preprocess","postprocess","processAllTokens","emStrongMask"]);static passThroughHooksRespectAsync=new Set(["preprocess","postprocess","processAllTokens"]);preprocess(e){return e}postprocess(e){return e}processAllTokens(e){return e}emStrongMask(e){return e}provideLexer(){return this.block?se.lex:se.lexInline}provideParser(){return this.block?ie.parse:ie.parseInline}},$u=class{defaults=Qs();options=this.setOptions;parse=this.parseMarkdown(!0);parseInline=this.parseMarkdown(!1);Parser=ie;Renderer=Xt;TextRenderer=ii;Lexer=se;Tokenizer=Zt;Hooks=ht;constructor(...e){this.use(...e)}walkTokens(e,t){let n=[];for(let s of e)switch(n=n.concat(t.call(this,s)),s.type){case"table":{let i=s;for(let o of i.header)n=n.concat(this.walkTokens(o.tokens,t));for(let o of i.rows)for(let a of o)n=n.concat(this.walkTokens(a.tokens,t));break}case"list":{let i=s;n=n.concat(this.walkTokens(i.items,t));break}default:{let i=s;this.defaults.extensions?.childTokens?.[i.type]?this.defaults.extensions.childTokens[i.type].forEach(o=>{let a=i[o].flat(1/0);n=n.concat(this.walkTokens(a,t))}):i.tokens&&(n=n.concat(this.walkTokens(i.tokens,t)))}}return n}use(...e){let t=this.defaults.extensions||{renderers:{},childTokens:{}};return e.forEach(n=>{let s={...n};if(s.async=this.defaults.async||s.async||!1,n.extensions&&(n.extensions.forEach(i=>{if(!i.name)throw new Error("extension name required");if("renderer"in i){let o=t.renderers[i.name];o?t.renderers[i.name]=function(...a){let c=i.renderer.apply(this,a);return c===!1&&(c=o.apply(this,a)),c}:t.renderers[i.name]=i.renderer}if("tokenizer"in i){if(!i.level||i.level!=="block"&&i.level!=="inline")throw new Error("extension level must be 'block' or 'inline'");let o=t[i.level];o?o.unshift(i.tokenizer):t[i.level]=[i.tokenizer],i.start&&(i.level==="block"?t.startBlock?t.startBlock.push(i.start):t.startBlock=[i.start]:i.level==="inline"&&(t.startInline?t.startInline.push(i.start):t.startInline=[i.start]))}"childTokens"in i&&i.childTokens&&(t.childTokens[i.name]=i.childTokens)}),s.extensions=t),n.renderer){let i=this.defaults.renderer||new Xt(this.defaults);for(let o in n.renderer){if(!(o in i))throw new Error(`renderer '${o}' does not exist`);if(["options","parser"].includes(o))continue;let a=o,c=n.renderer[a],r=i[a];i[a]=(...p)=>{let l=c.apply(i,p);return l===!1&&(l=r.apply(i,p)),l||""}}s.renderer=i}if(n.tokenizer){let i=this.defaults.tokenizer||new Zt(this.defaults);for(let o in n.tokenizer){if(!(o in i))throw new Error(`tokenizer '${o}' does not exist`);if(["options","rules","lexer"].includes(o))continue;let a=o,c=n.tokenizer[a],r=i[a];i[a]=(...p)=>{let l=c.apply(i,p);return l===!1&&(l=r.apply(i,p)),l}}s.tokenizer=i}if(n.hooks){let i=this.defaults.hooks||new ht;for(let o in n.hooks){if(!(o in i))throw new Error(`hook '${o}' does not exist`);if(["options","block"].includes(o))continue;let a=o,c=n.hooks[a],r=i[a];ht.passThroughHooks.has(o)?i[a]=p=>{if(this.defaults.async&&ht.passThroughHooksRespectAsync.has(o))return(async()=>{let u=await c.call(i,p);return r.call(i,u)})();let l=c.call(i,p);return r.call(i,l)}:i[a]=(...p)=>{if(this.defaults.async)return(async()=>{let u=await c.apply(i,p);return u===!1&&(u=await r.apply(i,p)),u})();let l=c.apply(i,p);return l===!1&&(l=r.apply(i,p)),l}}s.hooks=i}if(n.walkTokens){let i=this.defaults.walkTokens,o=n.walkTokens;s.walkTokens=function(a){let c=[];return c.push(o.call(this,a)),i&&(c=c.concat(i.call(this,a))),c}}this.defaults={...this.defaults,...s}}),this}setOptions(e){return this.defaults={...this.defaults,...e},this}lexer(e,t){return se.lex(e,t??this.defaults)}parser(e,t){return ie.parse(e,t??this.defaults)}parseMarkdown(e){return(t,n)=>{let s={...n},i={...this.defaults,...s},o=this.onError(!!i.silent,!!i.async);if(this.defaults.async===!0&&s.async===!1)return o(new Error("marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise."));if(typeof t>"u"||t===null)return o(new Error("marked(): input parameter is undefined or null"));if(typeof t!="string")return o(new Error("marked(): input parameter is of type "+Object.prototype.toString.call(t)+", string expected"));if(i.hooks&&(i.hooks.options=i,i.hooks.block=e),i.async)return(async()=>{let a=i.hooks?await i.hooks.preprocess(t):t,c=await(i.hooks?await i.hooks.provideLexer():e?se.lex:se.lexInline)(a,i),r=i.hooks?await i.hooks.processAllTokens(c):c;i.walkTokens&&await Promise.all(this.walkTokens(r,i.walkTokens));let p=await(i.hooks?await i.hooks.provideParser():e?ie.parse:ie.parseInline)(r,i);return i.hooks?await i.hooks.postprocess(p):p})().catch(o);try{i.hooks&&(t=i.hooks.preprocess(t));let a=(i.hooks?i.hooks.provideLexer():e?se.lex:se.lexInline)(t,i);i.hooks&&(a=i.hooks.processAllTokens(a)),i.walkTokens&&this.walkTokens(a,i.walkTokens);let c=(i.hooks?i.hooks.provideParser():e?ie.parse:ie.parseInline)(a,i);return i.hooks&&(c=i.hooks.postprocess(c)),c}catch(a){return o(a)}}}onError(e,t){return n=>{if(n.message+=`
Please report this to https://github.com/markedjs/marked.`,e){let s="<p>An error occurred:</p><pre>"+ve(n.message+"",!0)+"</pre>";return t?Promise.resolve(s):s}if(t)return Promise.reject(n);throw n}}},Be=new $u;function P(e,t){return Be.parse(e,t)}P.options=P.setOptions=function(e){return Be.setOptions(e),P.defaults=Be.defaults,ja(P.defaults),P};P.getDefaults=Qs;P.defaults=Fe;P.use=function(...e){return Be.use(...e),P.defaults=Be.defaults,ja(P.defaults),P};P.walkTokens=function(e,t){return Be.walkTokens(e,t)};P.parseInline=Be.parseInline;P.Parser=ie;P.parser=ie.parse;P.Renderer=Xt;P.TextRenderer=ii;P.Lexer=se;P.lexer=se.lex;P.Tokenizer=Zt;P.Hooks=ht;P.parse=P;P.options;P.setOptions;P.use;P.walkTokens;P.parseInline;ie.parse;se.lex;P.setOptions({gfm:!0,breaks:!0,mangle:!1});const yo=["a","b","blockquote","br","code","del","em","h1","h2","h3","h4","hr","i","li","ol","p","pre","strong","table","tbody","td","th","thead","tr","ul"],wo=["class","href","rel","target","title","start"];let $o=!1;const ku=14e4,xu=4e4;function Au(){$o||($o=!0,vs.addHook("afterSanitizeAttributes",e=>{!(e instanceof HTMLAnchorElement)||!e.getAttribute("href")||(e.setAttribute("rel","noreferrer noopener"),e.setAttribute("target","_blank"))}))}function ws(e){const t=e.trim();if(!t)return"";Au();const n=na(t,ku),s=n.truncated?`

… truncated (${n.total} chars, showing first ${n.text.length}).`:"";if(n.text.length>xu){const a=`<pre class="code-block">${Su(`${n.text}${s}`)}</pre>`;return vs.sanitize(a,{ALLOWED_TAGS:yo,ALLOWED_ATTR:wo})}const i=P.parse(`${n.text}${s}`);return vs.sanitize(i,{ALLOWED_TAGS:yo,ALLOWED_ATTR:wo})}function Su(e){return e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}function _u(e,t){return d`<span class=${t} aria-hidden="true">${e}</span>`}function Kt(e,t){e&&(e.textContent=t)}const Tu=1500,Eu=2e3,tr="Copy as markdown",Cu="Copied",Iu="Copy failed",Qn="📋",Lu="✓",Ru="!";async function Mu(e){if(!e)return!1;try{return await navigator.clipboard.writeText(e),!0}catch{return!1}}function Ht(e,t){e.title=t,e.setAttribute("aria-label",t)}function Pu(e){const t=e.label??tr;return d`
    <button
      class="chat-copy-btn"
      type="button"
      title=${t}
      aria-label=${t}
      @click=${async n=>{const s=n.currentTarget,i=s?.querySelector(".chat-copy-btn__icon");if(!s||s.dataset.copying==="1")return;s.dataset.copying="1",s.setAttribute("aria-busy","true"),s.disabled=!0;const o=await Mu(e.text());if(s.isConnected){if(delete s.dataset.copying,s.removeAttribute("aria-busy"),s.disabled=!1,!o){s.dataset.error="1",Ht(s,Iu),Kt(i,Ru),window.setTimeout(()=>{s.isConnected&&(delete s.dataset.error,Ht(s,t),Kt(i,Qn))},Eu);return}s.dataset.copied="1",Ht(s,Cu),Kt(i,Lu),window.setTimeout(()=>{s.isConnected&&(delete s.dataset.copied,Ht(s,t),Kt(i,Qn))},Tu)}}}
    >
      ${_u(Qn,"chat-copy-btn__icon")}
    </button>
  `}function Nu(e){return Pu({text:()=>e,label:tr})}const Ou={emoji:"🧩",detailKeys:["command","path","url","targetUrl","targetId","ref","element","node","nodeId","id","requestId","to","channelId","guildId","userId","name","query","pattern","messageId"]},Du={bash:{emoji:"🛠️",title:"Bash",detailKeys:["command"]},process:{emoji:"🧰",title:"Process",detailKeys:["sessionId"]},read:{emoji:"📖",title:"Read",detailKeys:["path"]},write:{emoji:"✍️",title:"Write",detailKeys:["path"]},edit:{emoji:"📝",title:"Edit",detailKeys:["path"]},attach:{emoji:"📎",title:"Attach",detailKeys:["path","url","fileName"]},browser:{emoji:"🌐",title:"Browser",actions:{status:{label:"status"},start:{label:"start"},stop:{label:"stop"},tabs:{label:"tabs"},open:{label:"open",detailKeys:["targetUrl"]},focus:{label:"focus",detailKeys:["targetId"]},close:{label:"close",detailKeys:["targetId"]},snapshot:{label:"snapshot",detailKeys:["targetUrl","targetId","ref","element","format"]},screenshot:{label:"screenshot",detailKeys:["targetUrl","targetId","ref","element"]},navigate:{label:"navigate",detailKeys:["targetUrl","targetId"]},console:{label:"console",detailKeys:["level","targetId"]},pdf:{label:"pdf",detailKeys:["targetId"]},upload:{label:"upload",detailKeys:["paths","ref","inputRef","element","targetId"]},dialog:{label:"dialog",detailKeys:["accept","promptText","targetId"]},act:{label:"act",detailKeys:["request.kind","request.ref","request.selector","request.text","request.value"]}}},canvas:{emoji:"🖼️",title:"Canvas",actions:{present:{label:"present",detailKeys:["target","node","nodeId"]},hide:{label:"hide",detailKeys:["node","nodeId"]},navigate:{label:"navigate",detailKeys:["url","node","nodeId"]},eval:{label:"eval",detailKeys:["javaScript","node","nodeId"]},snapshot:{label:"snapshot",detailKeys:["format","node","nodeId"]},a2ui_push:{label:"A2UI push",detailKeys:["jsonlPath","node","nodeId"]},a2ui_reset:{label:"A2UI reset",detailKeys:["node","nodeId"]}}},nodes:{emoji:"📱",title:"Nodes",actions:{status:{label:"status"},describe:{label:"describe",detailKeys:["node","nodeId"]},pending:{label:"pending"},approve:{label:"approve",detailKeys:["requestId"]},reject:{label:"reject",detailKeys:["requestId"]},notify:{label:"notify",detailKeys:["node","nodeId","title","body"]},camera_snap:{label:"camera snap",detailKeys:["node","nodeId","facing","deviceId"]},camera_list:{label:"camera list",detailKeys:["node","nodeId"]},camera_clip:{label:"camera clip",detailKeys:["node","nodeId","facing","duration","durationMs"]},screen_record:{label:"screen record",detailKeys:["node","nodeId","duration","durationMs","fps","screenIndex"]}}},cron:{emoji:"⏰",title:"Cron",actions:{status:{label:"status"},list:{label:"list"},add:{label:"add",detailKeys:["job.name","job.id","job.schedule","job.cron"]},update:{label:"update",detailKeys:["id"]},remove:{label:"remove",detailKeys:["id"]},run:{label:"run",detailKeys:["id"]},runs:{label:"runs",detailKeys:["id"]},wake:{label:"wake",detailKeys:["text","mode"]}}},gateway:{emoji:"🔌",title:"Gateway",actions:{restart:{label:"restart",detailKeys:["reason","delayMs"]},"config.get":{label:"config get"},"config.schema":{label:"config schema"},"config.apply":{label:"config apply",detailKeys:["restartDelayMs"]},"update.run":{label:"update run",detailKeys:["restartDelayMs"]}}},whatsapp_login:{emoji:"🟢",title:"WhatsApp Login",actions:{start:{label:"start"},wait:{label:"wait"}}},discord:{emoji:"💬",title:"Discord",actions:{react:{label:"react",detailKeys:["channelId","messageId","emoji"]},reactions:{label:"reactions",detailKeys:["channelId","messageId"]},sticker:{label:"sticker",detailKeys:["to","stickerIds"]},poll:{label:"poll",detailKeys:["question","to"]},permissions:{label:"permissions",detailKeys:["channelId"]},readMessages:{label:"read messages",detailKeys:["channelId","limit"]},sendMessage:{label:"send",detailKeys:["to","content"]},editMessage:{label:"edit",detailKeys:["channelId","messageId"]},deleteMessage:{label:"delete",detailKeys:["channelId","messageId"]},threadCreate:{label:"thread create",detailKeys:["channelId","name"]},threadList:{label:"thread list",detailKeys:["guildId","channelId"]},threadReply:{label:"thread reply",detailKeys:["channelId","content"]},pinMessage:{label:"pin",detailKeys:["channelId","messageId"]},unpinMessage:{label:"unpin",detailKeys:["channelId","messageId"]},listPins:{label:"list pins",detailKeys:["channelId"]},searchMessages:{label:"search",detailKeys:["guildId","content"]},memberInfo:{label:"member",detailKeys:["guildId","userId"]},roleInfo:{label:"roles",detailKeys:["guildId"]},emojiList:{label:"emoji list",detailKeys:["guildId"]},roleAdd:{label:"role add",detailKeys:["guildId","userId","roleId"]},roleRemove:{label:"role remove",detailKeys:["guildId","userId","roleId"]},channelInfo:{label:"channel",detailKeys:["channelId"]},channelList:{label:"channels",detailKeys:["guildId"]},voiceStatus:{label:"voice",detailKeys:["guildId","userId"]},eventList:{label:"events",detailKeys:["guildId"]},eventCreate:{label:"event create",detailKeys:["guildId","name"]},timeout:{label:"timeout",detailKeys:["guildId","userId"]},kick:{label:"kick",detailKeys:["guildId","userId"]},ban:{label:"ban",detailKeys:["guildId","userId"]}}},slack:{emoji:"💬",title:"Slack",actions:{react:{label:"react",detailKeys:["channelId","messageId","emoji"]},reactions:{label:"reactions",detailKeys:["channelId","messageId"]},sendMessage:{label:"send",detailKeys:["to","content"]},editMessage:{label:"edit",detailKeys:["channelId","messageId"]},deleteMessage:{label:"delete",detailKeys:["channelId","messageId"]},readMessages:{label:"read messages",detailKeys:["channelId","limit"]},pinMessage:{label:"pin",detailKeys:["channelId","messageId"]},unpinMessage:{label:"unpin",detailKeys:["channelId","messageId"]},listPins:{label:"list pins",detailKeys:["channelId"]},memberInfo:{label:"member",detailKeys:["userId"]},emojiList:{label:"emoji list"}}}},Bu={fallback:Ou,tools:Du},nr=Bu,ko=nr.fallback??{emoji:"🧩"},Fu=nr.tools??{};function Uu(e){return(e??"tool").trim()}function Ku(e){const t=e.replace(/_/g," ").trim();return t?t.split(/\s+/).map(n=>n.length<=2&&n.toUpperCase()===n?n:`${n.at(0)?.toUpperCase()??""}${n.slice(1)}`).join(" "):"Tool"}function Hu(e){const t=e?.trim();if(t)return t.replace(/_/g," ")}function sr(e){if(e!=null){if(typeof e=="string"){const t=e.trim();if(!t)return;const n=t.split(/\r?\n/)[0]?.trim()??"";return n?n.length>160?`${n.slice(0,157)}…`:n:void 0}if(typeof e=="number"||typeof e=="boolean")return String(e);if(Array.isArray(e)){const t=e.map(s=>sr(s)).filter(s=>!!s);if(t.length===0)return;const n=t.slice(0,3).join(", ");return t.length>3?`${n}…`:n}}}function zu(e,t){if(!e||typeof e!="object")return;let n=e;for(const s of t.split(".")){if(!s||!n||typeof n!="object")return;n=n[s]}return n}function ju(e,t){for(const n of t){const s=zu(e,n),i=sr(s);if(i)return i}}function qu(e){if(!e||typeof e!="object")return;const t=e,n=typeof t.path=="string"?t.path:void 0;if(!n)return;const s=typeof t.offset=="number"?t.offset:void 0,i=typeof t.limit=="number"?t.limit:void 0;return s!==void 0&&i!==void 0?`${n}:${s}-${s+i}`:n}function Wu(e){if(!e||typeof e!="object")return;const t=e;return typeof t.path=="string"?t.path:void 0}function Vu(e,t){if(!(!e||!t))return e.actions?.[t]??void 0}function Gu(e){const t=Uu(e.name),n=t.toLowerCase(),s=Fu[n],i=s?.emoji??ko.emoji??"🧩",o=s?.title??Ku(t),a=s?.label??t,c=e.args&&typeof e.args=="object"?e.args.action:void 0,r=typeof c=="string"?c.trim():void 0,p=Vu(s,r),l=Hu(p?.label??r);let u;n==="read"&&(u=qu(e.args)),!u&&(n==="write"||n==="edit"||n==="attach")&&(u=Wu(e.args));const h=p?.detailKeys??s?.detailKeys??ko.detailKeys??[];return!u&&h.length>0&&(u=ju(e.args,h)),!u&&e.meta&&(u=e.meta),u&&(u=Qu(u)),{name:t,emoji:i,title:o,label:a,verb:l,detail:u}}function Yu(e){const t=[];if(e.verb&&t.push(e.verb),e.detail&&t.push(e.detail),t.length!==0)return t.join(" · ")}function Qu(e){return e&&e.replace(/\/Users\/[^/]+/g,"~").replace(/\/home\/[^/]+/g,"~")}const Ju=80,Zu=2,xo=100;function Xu(e){const t=e.trim();if(t.startsWith("{")||t.startsWith("["))try{const n=JSON.parse(t);return"```json\n"+JSON.stringify(n,null,2)+"\n```"}catch{}return e}function ep(e){const t=e.split(`
`),n=t.slice(0,Zu),s=n.join(`
`);return s.length>xo?s.slice(0,xo)+"…":n.length<t.length?s+"…":s}function tp(e){const t=e,n=np(t.content),s=[];for(const i of n){const o=String(i.type??"").toLowerCase();(["toolcall","tool_call","tooluse","tool_use"].includes(o)||typeof i.name=="string"&&i.arguments!=null)&&s.push({kind:"call",name:i.name??"tool",args:sp(i.arguments??i.args)})}for(const i of n){const o=String(i.type??"").toLowerCase();if(o!=="toolresult"&&o!=="tool_result")continue;const a=ip(i),c=typeof i.name=="string"?i.name:"tool";s.push({kind:"result",name:c,text:a})}if(Fa(e)&&!s.some(i=>i.kind==="result")){const i=typeof t.toolName=="string"&&t.toolName||typeof t.tool_name=="string"&&t.tool_name||"tool",o=an(e)??void 0;s.push({kind:"result",name:i,text:o})}return s}function Ao(e,t){const n=Gu({name:e.name,args:e.args}),s=Yu(n),i=!!e.text?.trim(),o=!!t,a=o?()=>{if(i){t(Xu(e.text));return}const u=`## ${n.label}

${s?`**Command:** \`${s}\`

`:""}*No output — tool completed successfully.*`;t(u)}:void 0,c=i&&(e.text?.length??0)<=Ju,r=i&&!c,p=i&&c,l=!i;return d`
    <div
      class="chat-tool-card ${o?"chat-tool-card--clickable":""}"
      @click=${a}
      role=${o?"button":g}
      tabindex=${o?"0":g}
      @keydown=${o?u=>{u.key!=="Enter"&&u.key!==" "||(u.preventDefault(),a?.())}:g}
    >
      <div class="chat-tool-card__header">
        <div class="chat-tool-card__title">
          <span class="chat-tool-card__icon">${n.emoji}</span>
          <span>${n.label}</span>
        </div>
        ${o?d`<span class="chat-tool-card__action">${i?"View ›":"›"}</span>`:g}
        ${l&&!o?d`<span class="chat-tool-card__status">✓</span>`:g}
      </div>
      ${s?d`<div class="chat-tool-card__detail">${s}</div>`:g}
      ${l?d`<div class="chat-tool-card__status-text muted">Completed</div>`:g}
      ${r?d`<div class="chat-tool-card__preview mono">${ep(e.text)}</div>`:g}
      ${p?d`<div class="chat-tool-card__inline mono">${e.text}</div>`:g}
    </div>
  `}function np(e){return Array.isArray(e)?e.filter(Boolean):[]}function sp(e){if(typeof e!="string")return e;const t=e.trim();if(!t||!t.startsWith("{")&&!t.startsWith("["))return e;try{return JSON.parse(t)}catch{return e}}function ip(e){if(typeof e.text=="string")return e.text;if(typeof e.content=="string")return e.content}function op(e){return d`
    <div class="chat-group assistant">
      ${oi("assistant",e)}
      <div class="chat-group-messages">
        <div class="chat-bubble chat-reading-indicator" aria-hidden="true">
          <span class="chat-reading-indicator__dots">
            <span></span><span></span><span></span>
          </span>
        </div>
      </div>
    </div>
  `}function ap(e,t,n,s){const i=new Date(t).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"}),o=s?.name??"Assistant";return d`
    <div class="chat-group assistant">
      ${oi("assistant",s)}
      <div class="chat-group-messages">
        ${ir({role:"assistant",content:[{type:"text",text:e}]},{isStreaming:!0,showReasoning:!1},n)}
        <div class="chat-group-footer">
          <span class="chat-sender-name">${o}</span>
          <span class="chat-group-timestamp">${i}</span>
        </div>
      </div>
    </div>
  `}function rp(e,t){const n=Ys(e.role),s=t.assistantName??"Assistant",i=n==="user"?"You":n==="assistant"?s:n,o=n==="user"?"user":n==="assistant"?"assistant":"other",a=new Date(e.timestamp).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});return d`
    <div class="chat-group ${o}">
      ${oi(e.role,{name:s,avatar:t.assistantAvatar??null})}
      <div class="chat-group-messages">
        ${e.messages.map((c,r)=>ir(c.message,{isStreaming:e.isStreaming&&r===e.messages.length-1,showReasoning:t.showReasoning},t.onOpenSidebar))}
        <div class="chat-group-footer">
          <span class="chat-sender-name">${i}</span>
          <span class="chat-group-timestamp">${a}</span>
        </div>
      </div>
    </div>
  `}function oi(e,t){const n=Ys(e),s=t?.name?.trim()||"Assistant",i=t?.avatar?.trim()||"",o=n==="user"?"U":n==="assistant"?s.charAt(0).toUpperCase()||"A":n==="tool"?"⚙":"?",a=n==="user"?"user":n==="assistant"?"assistant":n==="tool"?"tool":"other";return i&&n==="assistant"?lp(i)?d`<img
        class="chat-avatar ${a}"
        src="${i}"
        alt="${s}"
      />`:d`<div class="chat-avatar ${a}">${i}</div>`:d`<div class="chat-avatar ${a}">${o}</div>`}function lp(e){return/^https?:\/\//i.test(e)||/^data:image\//i.test(e)}function ir(e,t,n){const s=e,i=typeof s.role=="string"?s.role:"unknown",o=Fa(e)||i.toLowerCase()==="toolresult"||i.toLowerCase()==="tool_result"||typeof s.toolCallId=="string"||typeof s.tool_call_id=="string",a=tp(e),c=a.length>0,r=an(e),p=t.showReasoning&&i==="assistant"?vl(e):null,l=r?.trim()?r:null,u=p?bl(p):null,h=l,v=i==="assistant"&&!!h?.trim(),w=["chat-bubble",v?"has-copy":"",t.isStreaming?"streaming":"","fade-in"].filter(Boolean).join(" ");return!h&&c&&o?d`${a.map($=>Ao($,n))}`:!h&&!c?g:d`
    <div class="${w}">
      ${v?Nu(h):g}
      ${u?d`<div class="chat-thinking">${ps(ws(u))}</div>`:g}
      ${h?d`<div class="chat-text">${ps(ws(h))}</div>`:g}
      ${a.map($=>Ao($,n))}
    </div>
  `}function cp(e){return d`
    <div class="sidebar-panel">
      <div class="sidebar-header">
        <div class="sidebar-title">Tool Output</div>
        <button @click=${e.onClose} class="btn" title="Close sidebar">
          ✕
        </button>
      </div>
      <div class="sidebar-content">
        ${e.error?d`
              <div class="callout danger">${e.error}</div>
              <button @click=${e.onViewRawText} class="btn" style="margin-top: 12px;">
                View Raw Text
              </button>
            `:e.content?d`<div class="sidebar-markdown">${ps(ws(e.content))}</div>`:d`<div class="muted">No content available</div>`}
      </div>
    </div>
  `}var dp=Object.defineProperty,up=Object.getOwnPropertyDescriptor,vn=(e,t,n,s)=>{for(var i=s>1?void 0:s?up(t,n):t,o=e.length-1,a;o>=0;o--)(a=e[o])&&(i=(s?a(t,n,i):a(i))||i);return s&&i&&dp(t,n,i),i};let et=class extends Ye{constructor(){super(...arguments),this.splitRatio=.6,this.minRatio=.4,this.maxRatio=.7,this.isDragging=!1,this.startX=0,this.startRatio=0,this.handleMouseDown=e=>{this.isDragging=!0,this.startX=e.clientX,this.startRatio=this.splitRatio,this.classList.add("dragging"),document.addEventListener("mousemove",this.handleMouseMove),document.addEventListener("mouseup",this.handleMouseUp),e.preventDefault()},this.handleMouseMove=e=>{if(!this.isDragging)return;const t=this.parentElement;if(!t)return;const n=t.getBoundingClientRect().width,i=(e.clientX-this.startX)/n;let o=this.startRatio+i;o=Math.max(this.minRatio,Math.min(this.maxRatio,o)),this.dispatchEvent(new CustomEvent("resize",{detail:{splitRatio:o},bubbles:!0,composed:!0}))},this.handleMouseUp=()=>{this.isDragging=!1,this.classList.remove("dragging"),document.removeEventListener("mousemove",this.handleMouseMove),document.removeEventListener("mouseup",this.handleMouseUp)}}render(){return d``}connectedCallback(){super.connectedCallback(),this.addEventListener("mousedown",this.handleMouseDown)}disconnectedCallback(){super.disconnectedCallback(),this.removeEventListener("mousedown",this.handleMouseDown),document.removeEventListener("mousemove",this.handleMouseMove),document.removeEventListener("mouseup",this.handleMouseUp)}};et.styles=Rr`
    :host {
      width: 4px;
      cursor: col-resize;
      background: var(--border, #333);
      transition: background 150ms ease-out;
      flex-shrink: 0;
      position: relative;
    }

    :host::before {
      content: "";
      position: absolute;
      top: 0;
      left: -4px;
      right: -4px;
      bottom: 0;
    }

    :host(:hover) {
      background: var(--accent, #007bff);
    }

    :host(.dragging) {
      background: var(--accent, #007bff);
    }
  `;vn([sn({type:Number})],et.prototype,"splitRatio",2);vn([sn({type:Number})],et.prototype,"minRatio",2);vn([sn({type:Number})],et.prototype,"maxRatio",2);et=vn([Yo("resizable-divider")],et);function pp(e){const t=e.connected,n=e.sending||e.stream!==null,i=e.sessions?.sessions?.find(l=>l.key===e.sessionKey)?.reasoningLevel??"off",o=e.showThinking&&i!=="off",a={name:e.assistantName,avatar:e.assistantAvatar??e.assistantAvatarUrl??null},c=e.connected?"Message (↩ to send, Shift+↩ for line breaks)":"Connect to the gateway to start chatting…",r=e.splitRatio??.6,p=!!(e.sidebarOpen&&e.onCloseSidebar);return d`
    <section class="card chat">
      ${e.disabledReason?d`<div class="callout">${e.disabledReason}</div>`:g}

      ${e.error?d`<div class="callout danger">${e.error}</div>`:g}

      ${e.focusMode?d`
            <button
              class="chat-focus-exit"
              type="button"
              @click=${e.onToggleFocusMode}
              aria-label="Exit focus mode"
              title="Exit focus mode"
            >
              ✕
            </button>
          `:g}

      <div
        class="chat-split-container ${p?"chat-split-container--open":""}"
      >
        <div
          class="chat-main"
          style="flex: ${p?`0 0 ${r*100}%`:"1 1 100%"}"
        >
          <div
            class="chat-thread"
            role="log"
            aria-live="polite"
            @scroll=${e.onChatScroll}
          >
            ${e.loading?d`<div class="muted">Loading chat…</div>`:g}
            ${Da(hp(e),l=>l.key,l=>l.kind==="reading-indicator"?op(a):l.kind==="stream"?ap(l.text,l.startedAt,e.onOpenSidebar,a):l.kind==="group"?rp(l,{onOpenSidebar:e.onOpenSidebar,showReasoning:o,assistantName:e.assistantName,assistantAvatar:a.avatar}):g)}
          </div>
        </div>

        ${p?d`
              <resizable-divider
                .splitRatio=${r}
                @resize=${l=>e.onSplitRatioChange?.(l.detail.splitRatio)}
              ></resizable-divider>
              <div class="chat-sidebar">
                ${cp({content:e.sidebarContent??null,error:e.sidebarError??null,onClose:e.onCloseSidebar,onViewRawText:()=>{!e.sidebarContent||!e.onOpenSidebar||e.onOpenSidebar(`\`\`\`
${e.sidebarContent}
\`\`\``)}})}
              </div>
            `:g}
      </div>

      ${e.queue.length?d`
            <div class="chat-queue" role="status" aria-live="polite">
              <div class="chat-queue__title">Queued (${e.queue.length})</div>
              <div class="chat-queue__list">
                ${e.queue.map(l=>d`
                    <div class="chat-queue__item">
                      <div class="chat-queue__text">${l.text}</div>
                      <button
                        class="btn chat-queue__remove"
                        type="button"
                        aria-label="Remove queued message"
                        @click=${()=>e.onQueueRemove(l.id)}
                      >
                        ✕
                      </button>
                    </div>
                  `)}
              </div>
            </div>
          `:g}

      <div class="chat-compose">
        <label class="field chat-compose__field">
          <span>Message</span>
          <textarea
            .value=${e.draft}
            ?disabled=${!e.connected}
            @keydown=${l=>{l.key==="Enter"&&(l.isComposing||l.keyCode===229||l.shiftKey||e.connected&&(l.preventDefault(),t&&e.onSend()))}}
            @input=${l=>e.onDraftChange(l.target.value)}
            placeholder=${c}
          ></textarea>
        </label>
        <div class="chat-compose__actions">
          <button
            class="btn"
            ?disabled=${!e.connected||e.sending}
            @click=${e.onNewSession}
          >
            New session
          </button>
          <button
            class="btn primary"
            ?disabled=${!e.connected}
            @click=${e.onSend}
          >
            ${n?"Queue":"Send"}
          </button>
        </div>
      </div>
    </section>
  `}const So=200;function fp(e){const t=[];let n=null;for(const s of e){if(s.kind!=="message"){n&&(t.push(n),n=null),t.push(s);continue}const i=Ba(s.message),o=Ys(i.role),a=i.timestamp||Date.now();!n||n.role!==o?(n&&t.push(n),n={kind:"group",key:`group:${o}:${s.key}`,role:o,messages:[{message:s.message,key:s.key}],timestamp:a,isStreaming:!1}):n.messages.push({message:s.message,key:s.key})}return n&&t.push(n),t}function hp(e){const t=[],n=Array.isArray(e.messages)?e.messages:[],s=Array.isArray(e.toolMessages)?e.toolMessages:[],i=Math.max(0,n.length-So);i>0&&t.push({kind:"message",key:"chat:history:notice",message:{role:"system",content:`Showing last ${So} messages (${i} hidden).`,timestamp:Date.now()}});for(let o=i;o<n.length;o++){const a=n[o],c=Ba(a);!e.showThinking&&c.role.toLowerCase()==="toolresult"||t.push({kind:"message",key:_o(a,o),message:a})}if(e.showThinking)for(let o=0;o<s.length;o++)t.push({kind:"message",key:_o(s[o],o+n.length),message:s[o]});if(e.stream!==null){const o=`stream:${e.sessionKey}:${e.streamStartedAt??"live"}`;e.stream.trim().length>0?t.push({kind:"stream",key:o,text:e.stream,startedAt:e.streamStartedAt??Date.now()}):t.push({kind:"reading-indicator",key:o})}return fp(t)}function _o(e,t){const n=e,s=typeof n.toolCallId=="string"?n.toolCallId:"";if(s)return`tool:${s}`;const i=typeof n.id=="string"?n.id:"";if(i)return`msg:${i}`;const o=typeof n.messageId=="string"?n.messageId:"";if(o)return`msg:${o}`;const a=typeof n.timestamp=="number"?n.timestamp:null,c=typeof n.role=="string"?n.role:"unknown",p=an(e)??(typeof n.content=="string"?n.content:null)??gp(e)??String(t),l=vp(p);return a?`msg:${c}:${a}:${l}`:`msg:${c}:${l}`}function gp(e){try{return JSON.stringify(e)}catch{return null}}function vp(e){let t=2166136261;for(let n=0;n<e.length;n++)t^=e.charCodeAt(n),t=Math.imul(t,16777619);return(t>>>0).toString(36)}function de(e){if(e)return Array.isArray(e.type)?e.type.filter(n=>n!=="null")[0]??e.type[0]:e.type}function or(e){if(!e)return"";if(e.default!==void 0)return e.default;switch(de(e)){case"object":return{};case"array":return[];case"boolean":return!1;case"number":case"integer":return 0;case"string":return"";default:return""}}function mn(e){return e.filter(t=>typeof t=="string").join(".")}function ee(e,t){const n=mn(e),s=t[n];if(s)return s;const i=n.split(".");for(const[o,a]of Object.entries(t)){if(!o.includes("*"))continue;const c=o.split(".");if(c.length!==i.length)continue;let r=!0;for(let p=0;p<i.length;p+=1)if(c[p]!=="*"&&c[p]!==i[p]){r=!1;break}if(r)return a}}function ye(e){return e.replace(/_/g," ").replace(/([a-z0-9])([A-Z])/g,"$1 $2").replace(/\s+/g," ").replace(/^./,t=>t.toUpperCase())}function mp(e){const t=mn(e).toLowerCase();return t.includes("token")||t.includes("password")||t.includes("secret")||t.includes("apikey")||t.endsWith("key")}const bp=new Set(["title","description","default","nullable"]);function yp(e){return Object.keys(e??{}).filter(n=>!bp.has(n)).length===0}function wp(e){if(e===void 0)return"";try{return JSON.stringify(e,null,2)??""}catch{return""}}const At={chevronDown:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`,plus:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,minus:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,trash:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`,edit:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`};function be(e){const{schema:t,value:n,path:s,hints:i,unsupported:o,disabled:a,onPatch:c}=e,r=e.showLabel??!0,p=de(t),l=ee(s,i),u=l?.label??t.title??ye(String(s.at(-1))),h=l?.help??t.description,v=mn(s);if(o.has(v))return d`<div class="cfg-field cfg-field--error">
      <div class="cfg-field__label">${u}</div>
      <div class="cfg-field__error">Unsupported schema node. Use Raw mode.</div>
    </div>`;if(t.anyOf||t.oneOf){const $=(t.anyOf??t.oneOf??[]).filter(A=>!(A.type==="null"||Array.isArray(A.type)&&A.type.includes("null")));if($.length===1)return be({...e,schema:$[0]});const x=A=>{if(A.const!==void 0)return A.const;if(A.enum&&A.enum.length===1)return A.enum[0]},E=$.map(x),I=E.every(A=>A!==void 0);if(I&&E.length>0&&E.length<=5){const A=n??t.default;return d`
        <div class="cfg-field">
          ${r?d`<label class="cfg-field__label">${u}</label>`:g}
          ${h?d`<div class="cfg-field__help">${h}</div>`:g}
          <div class="cfg-segmented">
            ${E.map((B,ue)=>d`
              <button
                type="button"
                class="cfg-segmented__btn ${B===A||String(B)===String(A)?"active":""}"
                ?disabled=${a}
                @click=${()=>c(s,B)}
              >
                ${String(B)}
              </button>
            `)}
          </div>
        </div>
      `}if(I&&E.length>5)return Eo({...e,options:E,value:n??t.default});const R=new Set($.map(A=>de(A)).filter(Boolean)),C=new Set([...R].map(A=>A==="integer"?"number":A));if([...C].every(A=>["string","number","boolean"].includes(A))){const A=C.has("string"),B=C.has("number");if(C.has("boolean")&&C.size===1)return be({...e,schema:{...t,type:"boolean",anyOf:void 0,oneOf:void 0}});if(A||B)return To({...e,inputType:B&&!A?"number":"text"})}}if(t.enum){const w=t.enum;if(w.length<=5){const $=n??t.default;return d`
        <div class="cfg-field">
          ${r?d`<label class="cfg-field__label">${u}</label>`:g}
          ${h?d`<div class="cfg-field__help">${h}</div>`:g}
          <div class="cfg-segmented">
            ${w.map(x=>d`
              <button
                type="button"
                class="cfg-segmented__btn ${x===$||String(x)===String($)?"active":""}"
                ?disabled=${a}
                @click=${()=>c(s,x)}
              >
                ${String(x)}
              </button>
            `)}
          </div>
        </div>
      `}return Eo({...e,options:w,value:n??t.default})}if(p==="object")return kp(e);if(p==="array")return xp(e);if(p==="boolean"){const w=typeof n=="boolean"?n:typeof t.default=="boolean"?t.default:!1;return d`
      <label class="cfg-toggle-row ${a?"disabled":""}">
        <div class="cfg-toggle-row__content">
          <span class="cfg-toggle-row__label">${u}</span>
          ${h?d`<span class="cfg-toggle-row__help">${h}</span>`:g}
        </div>
        <div class="cfg-toggle">
          <input
            type="checkbox"
            .checked=${w}
            ?disabled=${a}
            @change=${$=>c(s,$.target.checked)}
          />
          <span class="cfg-toggle__track"></span>
        </div>
      </label>
    `}return p==="number"||p==="integer"?$p(e):p==="string"?To({...e,inputType:"text"}):d`
    <div class="cfg-field cfg-field--error">
      <div class="cfg-field__label">${u}</div>
      <div class="cfg-field__error">Unsupported type: ${p}. Use Raw mode.</div>
    </div>
  `}function To(e){const{schema:t,value:n,path:s,hints:i,disabled:o,onPatch:a,inputType:c}=e,r=e.showLabel??!0,p=ee(s,i),l=p?.label??t.title??ye(String(s.at(-1))),u=p?.help??t.description,h=p?.sensitive??mp(s),v=p?.placeholder??(h?"••••":t.default!==void 0?`Default: ${t.default}`:""),w=n??"";return d`
    <div class="cfg-field">
      ${r?d`<label class="cfg-field__label">${l}</label>`:g}
      ${u?d`<div class="cfg-field__help">${u}</div>`:g}
      <div class="cfg-input-wrap">
        <input
          type=${h?"password":c}
          class="cfg-input"
          placeholder=${v}
          .value=${w==null?"":String(w)}
          ?disabled=${o}
          @input=${$=>{const x=$.target.value;if(c==="number"){if(x.trim()===""){a(s,void 0);return}const E=Number(x);a(s,Number.isNaN(E)?x:E);return}a(s,x)}}
        />
        ${t.default!==void 0?d`
          <button
            type="button"
            class="cfg-input__reset"
            title="Reset to default"
            ?disabled=${o}
            @click=${()=>a(s,t.default)}
          >↺</button>
        `:g}
      </div>
    </div>
  `}function $p(e){const{schema:t,value:n,path:s,hints:i,disabled:o,onPatch:a}=e,c=e.showLabel??!0,r=ee(s,i),p=r?.label??t.title??ye(String(s.at(-1))),l=r?.help??t.description,u=n??t.default??"",h=typeof u=="number"?u:0;return d`
    <div class="cfg-field">
      ${c?d`<label class="cfg-field__label">${p}</label>`:g}
      ${l?d`<div class="cfg-field__help">${l}</div>`:g}
      <div class="cfg-number">
        <button
          type="button"
          class="cfg-number__btn"
          ?disabled=${o}
          @click=${()=>a(s,h-1)}
        >−</button>
        <input
          type="number"
          class="cfg-number__input"
          .value=${u==null?"":String(u)}
          ?disabled=${o}
          @input=${v=>{const w=v.target.value,$=w===""?void 0:Number(w);a(s,$)}}
        />
        <button
          type="button"
          class="cfg-number__btn"
          ?disabled=${o}
          @click=${()=>a(s,h+1)}
        >+</button>
      </div>
    </div>
  `}function Eo(e){const{schema:t,value:n,path:s,hints:i,disabled:o,options:a,onPatch:c}=e,r=e.showLabel??!0,p=ee(s,i),l=p?.label??t.title??ye(String(s.at(-1))),u=p?.help??t.description,h=n??t.default,v=a.findIndex($=>$===h||String($)===String(h)),w="__unset__";return d`
    <div class="cfg-field">
      ${r?d`<label class="cfg-field__label">${l}</label>`:g}
      ${u?d`<div class="cfg-field__help">${u}</div>`:g}
      <select
        class="cfg-select"
        ?disabled=${o}
        .value=${v>=0?String(v):w}
        @change=${$=>{const x=$.target.value;c(s,x===w?void 0:a[Number(x)])}}
      >
        <option value=${w}>Select...</option>
        ${a.map(($,x)=>d`
          <option value=${String(x)}>${String($)}</option>
        `)}
      </select>
    </div>
  `}function kp(e){const{schema:t,value:n,path:s,hints:i,unsupported:o,disabled:a,onPatch:c}=e;e.showLabel;const r=ee(s,i),p=r?.label??t.title??ye(String(s.at(-1))),l=r?.help??t.description,u=n??t.default,h=u&&typeof u=="object"&&!Array.isArray(u)?u:{},v=t.properties??{},$=Object.entries(v).sort((R,C)=>{const A=ee([...s,R[0]],i)?.order??0,B=ee([...s,C[0]],i)?.order??0;return A!==B?A-B:R[0].localeCompare(C[0])}),x=new Set(Object.keys(v)),E=t.additionalProperties,I=!!E&&typeof E=="object";return s.length===1?d`
      <div class="cfg-fields">
        ${$.map(([R,C])=>be({schema:C,value:h[R],path:[...s,R],hints:i,unsupported:o,disabled:a,onPatch:c}))}
        ${I?Co({schema:E,value:h,path:s,hints:i,unsupported:o,disabled:a,reservedKeys:x,onPatch:c}):g}
      </div>
    `:d`
    <details class="cfg-object" open>
      <summary class="cfg-object__header">
        <span class="cfg-object__title">${p}</span>
        <span class="cfg-object__chevron">${At.chevronDown}</span>
      </summary>
      ${l?d`<div class="cfg-object__help">${l}</div>`:g}
      <div class="cfg-object__content">
        ${$.map(([R,C])=>be({schema:C,value:h[R],path:[...s,R],hints:i,unsupported:o,disabled:a,onPatch:c}))}
        ${I?Co({schema:E,value:h,path:s,hints:i,unsupported:o,disabled:a,reservedKeys:x,onPatch:c}):g}
      </div>
    </details>
  `}function xp(e){const{schema:t,value:n,path:s,hints:i,unsupported:o,disabled:a,onPatch:c}=e,r=e.showLabel??!0,p=ee(s,i),l=p?.label??t.title??ye(String(s.at(-1))),u=p?.help??t.description,h=Array.isArray(t.items)?t.items[0]:t.items;if(!h)return d`
      <div class="cfg-field cfg-field--error">
        <div class="cfg-field__label">${l}</div>
        <div class="cfg-field__error">Unsupported array schema. Use Raw mode.</div>
      </div>
    `;const v=Array.isArray(n)?n:Array.isArray(t.default)?t.default:[];return d`
    <div class="cfg-array">
      <div class="cfg-array__header">
        ${r?d`<span class="cfg-array__label">${l}</span>`:g}
        <span class="cfg-array__count">${v.length} item${v.length!==1?"s":""}</span>
        <button
          type="button"
          class="cfg-array__add"
          ?disabled=${a}
          @click=${()=>{const w=[...v,or(h)];c(s,w)}}
        >
          <span class="cfg-array__add-icon">${At.plus}</span>
          Add
        </button>
      </div>
      ${u?d`<div class="cfg-array__help">${u}</div>`:g}
      
      ${v.length===0?d`
        <div class="cfg-array__empty">
          No items yet. Click "Add" to create one.
        </div>
      `:d`
        <div class="cfg-array__items">
          ${v.map((w,$)=>d`
            <div class="cfg-array__item">
              <div class="cfg-array__item-header">
                <span class="cfg-array__item-index">#${$+1}</span>
                <button
                  type="button"
                  class="cfg-array__item-remove"
                  title="Remove item"
                  ?disabled=${a}
                  @click=${()=>{const x=[...v];x.splice($,1),c(s,x)}}
                >
                  ${At.trash}
                </button>
              </div>
              <div class="cfg-array__item-content">
                ${be({schema:h,value:w,path:[...s,$],hints:i,unsupported:o,disabled:a,showLabel:!1,onPatch:c})}
              </div>
            </div>
          `)}
        </div>
      `}
    </div>
  `}function Co(e){const{schema:t,value:n,path:s,hints:i,unsupported:o,disabled:a,reservedKeys:c,onPatch:r}=e,p=yp(t),l=Object.entries(n??{}).filter(([u])=>!c.has(u));return d`
    <div class="cfg-map">
      <div class="cfg-map__header">
        <span class="cfg-map__label">Custom entries</span>
        <button
          type="button"
          class="cfg-map__add"
          ?disabled=${a}
          @click=${()=>{const u={...n??{}};let h=1,v=`custom-${h}`;for(;v in u;)h+=1,v=`custom-${h}`;u[v]=p?{}:or(t),r(s,u)}}
        >
          <span class="cfg-map__add-icon">${At.plus}</span>
          Add Entry
        </button>
      </div>
      
      ${l.length===0?d`
        <div class="cfg-map__empty">No custom entries.</div>
      `:d`
        <div class="cfg-map__items">
          ${l.map(([u,h])=>{const v=[...s,u],w=wp(h);return d`
              <div class="cfg-map__item">
                <div class="cfg-map__item-key">
                  <input
                    type="text"
                    class="cfg-input cfg-input--sm"
                    placeholder="Key"
                    .value=${u}
                    ?disabled=${a}
                    @change=${$=>{const x=$.target.value.trim();if(!x||x===u)return;const E={...n??{}};x in E||(E[x]=E[u],delete E[u],r(s,E))}}
                  />
                </div>
                <div class="cfg-map__item-value">
                  ${p?d`
                        <textarea
                          class="cfg-textarea cfg-textarea--sm"
                          placeholder="JSON value"
                          rows="2"
                          .value=${w}
                          ?disabled=${a}
                          @change=${$=>{const x=$.target,E=x.value.trim();if(!E){r(v,void 0);return}try{r(v,JSON.parse(E))}catch{x.value=w}}}
                        ></textarea>
                      `:be({schema:t,value:h,path:v,hints:i,unsupported:o,disabled:a,showLabel:!1,onPatch:r})}
                </div>
                <button
                  type="button"
                  class="cfg-map__item-remove"
                  title="Remove entry"
                  ?disabled=${a}
                  @click=${()=>{const $={...n??{}};delete $[u],r(s,$)}}
                >
                  ${At.trash}
                </button>
              </div>
            `})}
        </div>
      `}
    </div>
  `}const Io={env:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,update:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`,agents:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"></path><circle cx="8" cy="14" r="1"></circle><circle cx="16" cy="14" r="1"></circle></svg>`,auth:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`,channels:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`,messages:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>`,commands:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`,hooks:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>`,skills:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`,tools:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>`,gateway:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`,wizard:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M15 4V2"></path><path d="M15 16v-2"></path><path d="M8 9h2"></path><path d="M20 9h2"></path><path d="M17.8 11.8 19 13"></path><path d="M15 9h0"></path><path d="M17.8 6.2 19 5"></path><path d="m3 21 9-9"></path><path d="M12.2 6.2 11 5"></path></svg>`,meta:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>`,logging:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>`,browser:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="4"></circle><line x1="21.17" y1="8" x2="12" y2="8"></line><line x1="3.95" y1="6.06" x2="8.54" y2="14"></line><line x1="10.88" y1="21.94" x2="15.46" y2="14"></line></svg>`,ui:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>`,models:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>`,bindings:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>`,broadcast:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"></path><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"></path><circle cx="12" cy="12" r="2"></circle><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"></path><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"></path></svg>`,audio:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`,session:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`,cron:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`,web:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`,discovery:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,canvasHost:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`,talk:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`,plugins:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2v6"></path><path d="m4.93 10.93 4.24 4.24"></path><path d="M2 12h6"></path><path d="m4.93 13.07 4.24-4.24"></path><path d="M12 22v-6"></path><path d="m19.07 13.07-4.24-4.24"></path><path d="M22 12h-6"></path><path d="m19.07 10.93-4.24 4.24"></path></svg>`,default:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`},ai={env:{label:"Environment Variables",description:"Environment variables passed to the gateway process"},update:{label:"Updates",description:"Auto-update settings and release channel"},agents:{label:"Agents",description:"Agent configurations, models, and identities"},auth:{label:"Authentication",description:"API keys and authentication profiles"},channels:{label:"Channels",description:"Messaging channels (Telegram, Discord, Slack, etc.)"},messages:{label:"Messages",description:"Message handling and routing settings"},commands:{label:"Commands",description:"Custom slash commands"},hooks:{label:"Hooks",description:"Webhooks and event hooks"},skills:{label:"Skills",description:"Skill packs and capabilities"},tools:{label:"Tools",description:"Tool configurations (browser, search, etc.)"},gateway:{label:"Gateway",description:"Gateway server settings (port, auth, binding)"},wizard:{label:"Setup Wizard",description:"Setup wizard state and history"},meta:{label:"Metadata",description:"Gateway metadata and version information"},logging:{label:"Logging",description:"Log levels and output configuration"},browser:{label:"Browser",description:"Browser automation settings"},ui:{label:"UI",description:"User interface preferences"},models:{label:"Models",description:"AI model configurations and providers"},bindings:{label:"Bindings",description:"Key bindings and shortcuts"},broadcast:{label:"Broadcast",description:"Broadcast and notification settings"},audio:{label:"Audio",description:"Audio input/output settings"},session:{label:"Session",description:"Session management and persistence"},cron:{label:"Cron",description:"Scheduled tasks and automation"},web:{label:"Web",description:"Web server and API settings"},discovery:{label:"Discovery",description:"Service discovery and networking"},canvasHost:{label:"Canvas Host",description:"Canvas rendering and display"},talk:{label:"Talk",description:"Voice and speech settings"},plugins:{label:"Plugins",description:"Plugin management and extensions"}};function Lo(e){return Io[e]??Io.default}function Ap(e,t,n){if(!n)return!0;const s=n.toLowerCase(),i=ai[e];return e.toLowerCase().includes(s)||i&&(i.label.toLowerCase().includes(s)||i.description.toLowerCase().includes(s))?!0:gt(t,s)}function gt(e,t){if(e.title?.toLowerCase().includes(t)||e.description?.toLowerCase().includes(t)||e.enum?.some(s=>String(s).toLowerCase().includes(t)))return!0;if(e.properties){for(const[s,i]of Object.entries(e.properties))if(s.toLowerCase().includes(t)||gt(i,t))return!0}if(e.items){const s=Array.isArray(e.items)?e.items:[e.items];for(const i of s)if(i&&gt(i,t))return!0}if(e.additionalProperties&&typeof e.additionalProperties=="object"&&gt(e.additionalProperties,t))return!0;const n=e.anyOf??e.oneOf??e.allOf;if(n){for(const s of n)if(s&&gt(s,t))return!0}return!1}function Sp(e){if(!e.schema)return d`<div class="muted">Schema unavailable.</div>`;const t=e.schema,n=e.value??{};if(de(t)!=="object"||!t.properties)return d`<div class="callout danger">Unsupported schema. Use Raw.</div>`;const s=new Set(e.unsupportedPaths??[]),i=t.properties,o=e.searchQuery??"",a=e.activeSection,c=e.activeSubsection??null;let r=Object.entries(i);a&&(r=r.filter(([l])=>l===a)),o&&(r=r.filter(([l,u])=>Ap(l,u,o))),r.sort((l,u)=>{const h=ee([l[0]],e.uiHints)?.order??50,v=ee([u[0]],e.uiHints)?.order??50;return h!==v?h-v:l[0].localeCompare(u[0])});let p=null;if(a&&c&&r.length===1){const l=r[0]?.[1];l&&de(l)==="object"&&l.properties&&l.properties[c]&&(p={sectionKey:a,subsectionKey:c,schema:l.properties[c]})}return r.length===0?d`
      <div class="config-empty">
        <div class="config-empty__icon">🔍</div>
        <div class="config-empty__text">
          ${o?`No settings match "${o}"`:"No settings in this section"}
        </div>
      </div>
    `:d`
    <div class="config-form config-form--modern">
      ${p?(()=>{const{sectionKey:l,subsectionKey:u,schema:h}=p,v=ee([l,u],e.uiHints),w=v?.label??h.title??ye(u),$=v?.help??h.description??"",x=n[l],E=x&&typeof x=="object"?x[u]:void 0,I=`config-section-${l}-${u}`;return d`
              <section class="config-section-card" id=${I}>
                <div class="config-section-card__header">
                  <span class="config-section-card__icon">${Lo(l)}</span>
                  <div class="config-section-card__titles">
                    <h3 class="config-section-card__title">${w}</h3>
                    ${$?d`<p class="config-section-card__desc">${$}</p>`:g}
                  </div>
                </div>
                <div class="config-section-card__content">
                  ${be({schema:h,value:E,path:[l,u],hints:e.uiHints,unsupported:s,disabled:e.disabled??!1,showLabel:!1,onPatch:e.onPatch})}
                </div>
              </section>
            `})():r.map(([l,u])=>{const h=ai[l]??{label:l.charAt(0).toUpperCase()+l.slice(1),description:u.description??""};return d`
              <section class="config-section-card" id="config-section-${l}">
                <div class="config-section-card__header">
                  <span class="config-section-card__icon">${Lo(l)}</span>
                  <div class="config-section-card__titles">
                    <h3 class="config-section-card__title">${h.label}</h3>
                    ${h.description?d`<p class="config-section-card__desc">${h.description}</p>`:g}
                  </div>
                </div>
                <div class="config-section-card__content">
                  ${be({schema:u,value:n[l],path:[l],hints:e.uiHints,unsupported:s,disabled:e.disabled??!1,showLabel:!1,onPatch:e.onPatch})}
                </div>
              </section>
            `})}
    </div>
  `}const _p=new Set(["title","description","default","nullable"]);function Tp(e){return Object.keys(e??{}).filter(n=>!_p.has(n)).length===0}function ar(e){const t=e.filter(i=>i!=null),n=t.length!==e.length,s=[];for(const i of t)s.some(o=>Object.is(o,i))||s.push(i);return{enumValues:s,nullable:n}}function rr(e){return!e||typeof e!="object"?{schema:null,unsupportedPaths:["<root>"]}:bt(e,[])}function bt(e,t){const n=new Set,s={...e},i=mn(t)||"<root>";if(e.anyOf||e.oneOf||e.allOf){const c=Ep(e,t);return c||{schema:e,unsupportedPaths:[i]}}const o=Array.isArray(e.type)&&e.type.includes("null"),a=de(e)??(e.properties||e.additionalProperties?"object":void 0);if(s.type=a??e.type,s.nullable=o||e.nullable,s.enum){const{enumValues:c,nullable:r}=ar(s.enum);s.enum=c,r&&(s.nullable=!0),c.length===0&&n.add(i)}if(a==="object"){const c=e.properties??{},r={};for(const[p,l]of Object.entries(c)){const u=bt(l,[...t,p]);u.schema&&(r[p]=u.schema);for(const h of u.unsupportedPaths)n.add(h)}if(s.properties=r,e.additionalProperties===!0)n.add(i);else if(e.additionalProperties===!1)s.additionalProperties=!1;else if(e.additionalProperties&&typeof e.additionalProperties=="object"&&!Tp(e.additionalProperties)){const p=bt(e.additionalProperties,[...t,"*"]);s.additionalProperties=p.schema??e.additionalProperties,p.unsupportedPaths.length>0&&n.add(i)}}else if(a==="array"){const c=Array.isArray(e.items)?e.items[0]:e.items;if(!c)n.add(i);else{const r=bt(c,[...t,"*"]);s.items=r.schema??c,r.unsupportedPaths.length>0&&n.add(i)}}else a!=="string"&&a!=="number"&&a!=="integer"&&a!=="boolean"&&!s.enum&&n.add(i);return{schema:s,unsupportedPaths:Array.from(n)}}function Ep(e,t){if(e.allOf)return null;const n=e.anyOf??e.oneOf;if(!n)return null;const s=[],i=[];let o=!1;for(const c of n){if(!c||typeof c!="object")return null;if(Array.isArray(c.enum)){const{enumValues:r,nullable:p}=ar(c.enum);s.push(...r),p&&(o=!0);continue}if("const"in c){if(c.const==null){o=!0;continue}s.push(c.const);continue}if(de(c)==="null"){o=!0;continue}i.push(c)}if(s.length>0&&i.length===0){const c=[];for(const r of s)c.some(p=>Object.is(p,r))||c.push(r);return{schema:{...e,enum:c,nullable:o,anyOf:void 0,oneOf:void 0,allOf:void 0},unsupportedPaths:[]}}if(i.length===1){const c=bt(i[0],t);return c.schema&&(c.schema.nullable=o||c.schema.nullable),c}const a=["string","number","integer","boolean"];return i.length>0&&s.length===0&&i.every(c=>c.type&&a.includes(String(c.type)))?{schema:{...e,nullable:o},unsupportedPaths:[]}:null}const $s={all:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>`,env:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,update:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`,agents:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"></path><circle cx="8" cy="14" r="1"></circle><circle cx="16" cy="14" r="1"></circle></svg>`,auth:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`,channels:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`,messages:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>`,commands:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`,hooks:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>`,skills:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`,tools:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>`,gateway:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`,wizard:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 4V2"></path><path d="M15 16v-2"></path><path d="M8 9h2"></path><path d="M20 9h2"></path><path d="M17.8 11.8 19 13"></path><path d="M15 9h0"></path><path d="M17.8 6.2 19 5"></path><path d="m3 21 9-9"></path><path d="M12.2 6.2 11 5"></path></svg>`,meta:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>`,logging:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>`,browser:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="4"></circle><line x1="21.17" y1="8" x2="12" y2="8"></line><line x1="3.95" y1="6.06" x2="8.54" y2="14"></line><line x1="10.88" y1="21.94" x2="15.46" y2="14"></line></svg>`,ui:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>`,models:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>`,bindings:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>`,broadcast:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"></path><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"></path><circle cx="12" cy="12" r="2"></circle><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"></path><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"></path></svg>`,audio:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`,session:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`,cron:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`,web:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`,discovery:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,canvasHost:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`,talk:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`,plugins:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v6"></path><path d="m4.93 10.93 4.24 4.24"></path><path d="M2 12h6"></path><path d="m4.93 13.07 4.24-4.24"></path><path d="M12 22v-6"></path><path d="m19.07 13.07-4.24-4.24"></path><path d="M22 12h-6"></path><path d="m19.07 10.93-4.24 4.24"></path></svg>`,default:d`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`},Ro=[{key:"env",label:"Environment"},{key:"update",label:"Updates"},{key:"agents",label:"Agents"},{key:"auth",label:"Authentication"},{key:"channels",label:"Channels"},{key:"messages",label:"Messages"},{key:"commands",label:"Commands"},{key:"hooks",label:"Hooks"},{key:"skills",label:"Skills"},{key:"tools",label:"Tools"},{key:"gateway",label:"Gateway"},{key:"wizard",label:"Setup Wizard"}],Mo="__all__";function Po(e){return $s[e]??$s.default}function Cp(e,t){const n=ai[e];return n||{label:t?.title??ye(e),description:t?.description??""}}function Ip(e){const{key:t,schema:n,uiHints:s}=e;if(!n||de(n)!=="object"||!n.properties)return[];const i=Object.entries(n.properties).map(([o,a])=>{const c=ee([t,o],s),r=c?.label??a.title??ye(o),p=c?.help??a.description??"",l=c?.order??50;return{key:o,label:r,description:p,order:l}});return i.sort((o,a)=>o.order!==a.order?o.order-a.order:o.key.localeCompare(a.key)),i}function Lp(e,t){if(!e||!t)return[];const n=[];function s(i,o,a){if(i===o)return;if(typeof i!=typeof o){n.push({path:a,from:i,to:o});return}if(typeof i!="object"||i===null||o===null){i!==o&&n.push({path:a,from:i,to:o});return}if(Array.isArray(i)&&Array.isArray(o)){JSON.stringify(i)!==JSON.stringify(o)&&n.push({path:a,from:i,to:o});return}const c=i,r=o,p=new Set([...Object.keys(c),...Object.keys(r)]);for(const l of p)s(c[l],r[l],a?`${a}.${l}`:l)}return s(e,t,""),n}function No(e,t=40){let n;try{n=JSON.stringify(e)??String(e)}catch{n=String(e)}return n.length<=t?n:n.slice(0,t-3)+"..."}function Rp(e){const t=e.valid==null?"unknown":e.valid?"valid":"invalid",n=rr(e.schema),s=n.schema?n.unsupportedPaths.length>0:!1,i=!!e.formValue&&!e.loading&&!s,o=e.connected&&!e.saving&&(e.formMode==="raw"?!0:i),a=e.connected&&!e.applying&&!e.updating&&(e.formMode==="raw"?!0:i),c=e.connected&&!e.applying&&!e.updating,r=n.schema?.properties??{},p=Ro.filter(A=>A.key in r),l=new Set(Ro.map(A=>A.key)),u=Object.keys(r).filter(A=>!l.has(A)).map(A=>({key:A,label:A.charAt(0).toUpperCase()+A.slice(1)})),h=[...p,...u],v=e.activeSection&&n.schema&&de(n.schema)==="object"?n.schema.properties?.[e.activeSection]:void 0,w=e.activeSection?Cp(e.activeSection,v):null,$=e.activeSection?Ip({key:e.activeSection,schema:v,uiHints:e.uiHints}):[],x=e.formMode==="form"&&!!e.activeSection&&$.length>0,E=e.activeSubsection===Mo,I=e.searchQuery||E?null:e.activeSubsection??$[0]?.key??null,R=e.formMode==="form"?Lp(e.originalValue,e.formValue):[],C=R.length>0;return d`
    <div class="config-layout">
      <!-- Sidebar -->
      <aside class="config-sidebar">
        <div class="config-sidebar__header">
          <div class="config-sidebar__title">Settings</div>
          <span class="pill pill--sm ${t==="valid"?"pill--ok":t==="invalid"?"pill--danger":""}">${t}</span>
        </div>
        
        <!-- Search -->
        <div class="config-search">
          <svg class="config-search__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"></circle>
            <path d="M21 21l-4.35-4.35"></path>
          </svg>
          <input
            type="text"
            class="config-search__input"
            placeholder="Search settings..."
            .value=${e.searchQuery}
            @input=${A=>e.onSearchChange(A.target.value)}
          />
          ${e.searchQuery?d`
            <button 
              class="config-search__clear"
              @click=${()=>e.onSearchChange("")}
            >×</button>
          `:g}
        </div>
        
        <!-- Section nav -->
        <nav class="config-nav">
          <button
            class="config-nav__item ${e.activeSection===null?"active":""}"
            @click=${()=>e.onSectionChange(null)}
          >
            <span class="config-nav__icon">${$s.all}</span>
            <span class="config-nav__label">All Settings</span>
          </button>
          ${h.map(A=>d`
            <button
              class="config-nav__item ${e.activeSection===A.key?"active":""}"
              @click=${()=>e.onSectionChange(A.key)}
            >
              <span class="config-nav__icon">${Po(A.key)}</span>
              <span class="config-nav__label">${A.label}</span>
            </button>
          `)}
        </nav>
        
        <!-- Mode toggle at bottom -->
        <div class="config-sidebar__footer">
          <div class="config-mode-toggle">
            <button
              class="config-mode-toggle__btn ${e.formMode==="form"?"active":""}"
              ?disabled=${e.schemaLoading||!e.schema}
              @click=${()=>e.onFormModeChange("form")}
            >
              Form
            </button>
            <button
              class="config-mode-toggle__btn ${e.formMode==="raw"?"active":""}"
              @click=${()=>e.onFormModeChange("raw")}
            >
              Raw
            </button>
          </div>
        </div>
      </aside>
      
      <!-- Main content -->
      <main class="config-main">
        <!-- Action bar -->
        <div class="config-actions">
          <div class="config-actions__left">
            ${C?d`
              <span class="config-changes-badge">${R.length} unsaved change${R.length!==1?"s":""}</span>
            `:d`
              <span class="config-status muted">No changes</span>
            `}
          </div>
          <div class="config-actions__right">
            <button class="btn btn--sm" ?disabled=${e.loading} @click=${e.onReload}>
              ${e.loading?"Loading…":"Reload"}
            </button>
            <button
              class="btn btn--sm primary"
              ?disabled=${!o}
              @click=${e.onSave}
            >
              ${e.saving?"Saving…":"Save"}
            </button>
            <button
              class="btn btn--sm"
              ?disabled=${!a}
              @click=${e.onApply}
            >
              ${e.applying?"Applying…":"Apply"}
            </button>
            <button
              class="btn btn--sm"
              ?disabled=${!c}
              @click=${e.onUpdate}
            >
              ${e.updating?"Updating…":"Update"}
            </button>
          </div>
        </div>
        
        <!-- Diff panel -->
        ${C?d`
          <details class="config-diff">
            <summary class="config-diff__summary">
              <span>View ${R.length} pending change${R.length!==1?"s":""}</span>
              <svg class="config-diff__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </summary>
            <div class="config-diff__content">
              ${R.map(A=>d`
                <div class="config-diff__item">
                  <div class="config-diff__path">${A.path}</div>
                  <div class="config-diff__values">
                    <span class="config-diff__from">${No(A.from)}</span>
                    <span class="config-diff__arrow">→</span>
                    <span class="config-diff__to">${No(A.to)}</span>
                  </div>
                </div>
              `)}
            </div>
          </details>
        `:g}

        ${w&&e.formMode==="form"?d`
              <div class="config-section-hero">
                <div class="config-section-hero__icon">${Po(e.activeSection??"")}</div>
                <div class="config-section-hero__text">
                  <div class="config-section-hero__title">${w.label}</div>
                  ${w.description?d`<div class="config-section-hero__desc">${w.description}</div>`:g}
                </div>
              </div>
            `:g}

        ${x?d`
              <div class="config-subnav">
                <button
                  class="config-subnav__item ${I===null?"active":""}"
                  @click=${()=>e.onSubsectionChange(Mo)}
                >
                  All
                </button>
                ${$.map(A=>d`
                    <button
                      class="config-subnav__item ${I===A.key?"active":""}"
                      title=${A.description||A.label}
                      @click=${()=>e.onSubsectionChange(A.key)}
                    >
                      ${A.label}
                    </button>
                  `)}
              </div>
            `:g}

        <!-- Form content -->
        <div class="config-content">
          ${e.formMode==="form"?d`
                ${e.schemaLoading?d`<div class="config-loading">
                      <div class="config-loading__spinner"></div>
                      <span>Loading schema…</span>
                    </div>`:Sp({schema:n.schema,uiHints:e.uiHints,value:e.formValue,disabled:e.loading||!e.formValue,unsupportedPaths:n.unsupportedPaths,onPatch:e.onFormPatch,searchQuery:e.searchQuery,activeSection:e.activeSection,activeSubsection:I})}
                ${s?d`<div class="callout danger" style="margin-top: 12px;">
                      Form view can't safely edit some fields.
                      Use Raw to avoid losing config entries.
                    </div>`:g}
              `:d`
                <label class="field config-raw-field">
                  <span>Raw JSON5</span>
                  <textarea
                    .value=${e.raw}
                    @input=${A=>e.onRawChange(A.target.value)}
                  ></textarea>
                </label>
              `}
        </div>

        ${e.issues.length>0?d`<div class="callout danger" style="margin-top: 12px;">
              <pre class="code-block">${JSON.stringify(e.issues,null,2)}</pre>
            </div>`:g}
      </main>
    </div>
  `}function Mp(e){if(!e&&e!==0)return"n/a";const t=Math.round(e/1e3);if(t<60)return`${t}s`;const n=Math.round(t/60);return n<60?`${n}m`:`${Math.round(n/60)}h`}function Pp(e,t){const n=t.snapshot,s=n?.channels;if(!n||!s)return!1;const i=s[e],o=typeof i?.configured=="boolean"&&i.configured,a=typeof i?.running=="boolean"&&i.running,c=typeof i?.connected=="boolean"&&i.connected,p=(n.channelAccounts?.[e]??[]).some(l=>l.configured||l.running||l.connected);return o||a||c||p}function Np(e,t){return t?.[e]?.length??0}function lr(e,t){const n=Np(e,t);return n<2?g:d`<div class="account-count">Accounts (${n})</div>`}function Op(e,t){let n=e;for(const s of t){if(!n)return null;const i=de(n);if(i==="object"){const o=n.properties??{};if(typeof s=="string"&&o[s]){n=o[s];continue}const a=n.additionalProperties;if(typeof s=="string"&&a&&typeof a=="object"){n=a;continue}return null}if(i==="array"){if(typeof s!="number")return null;n=(Array.isArray(n.items)?n.items[0]:n.items)??null;continue}return null}return n}function Dp(e,t){const s=(e.channels??{})[t],i=e[t];return(s&&typeof s=="object"?s:null)??(i&&typeof i=="object"?i:null)??{}}function Bp(e){const t=rr(e.schema),n=t.schema;if(!n)return d`<div class="callout danger">Schema unavailable. Use Raw.</div>`;const s=Op(n,["channels",e.channelId]);if(!s)return d`<div class="callout danger">Channel config schema unavailable.</div>`;const i=e.configValue??{},o=Dp(i,e.channelId);return d`
    <div class="config-form">
      ${be({schema:s,value:o,path:["channels",e.channelId],hints:e.uiHints,unsupported:new Set(t.unsupportedPaths),disabled:e.disabled,showLabel:!1,onPatch:e.onPatch})}
    </div>
  `}function _e(e){const{channelId:t,props:n}=e,s=n.configSaving||n.configSchemaLoading;return d`
    <div style="margin-top: 16px;">
      ${n.configSchemaLoading?d`<div class="muted">Loading config schema…</div>`:Bp({channelId:t,configValue:n.configForm,schema:n.configSchema,uiHints:n.configUiHints,disabled:s,onPatch:n.onConfigPatch})}
      <div class="row" style="margin-top: 12px;">
        <button
          class="btn primary"
          ?disabled=${s||!n.configFormDirty}
          @click=${()=>n.onConfigSave()}
        >
          ${n.configSaving?"Saving…":"Save"}
        </button>
        <button
          class="btn"
          ?disabled=${s}
          @click=${()=>n.onConfigReload()}
        >
          Reload
        </button>
      </div>
    </div>
  `}function Fp(e){const{props:t,discord:n,accountCountLabel:s}=e;return d`
    <div class="card">
      <div class="card-title">Discord</div>
      <div class="card-sub">Bot status and channel configuration.</div>
      ${s}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">Configured</span>
          <span>${n?.configured?"Yes":"No"}</span>
        </div>
        <div>
          <span class="label">Running</span>
          <span>${n?.running?"Yes":"No"}</span>
        </div>
        <div>
          <span class="label">Last start</span>
          <span>${n?.lastStartAt?O(n.lastStartAt):"n/a"}</span>
        </div>
        <div>
          <span class="label">Last probe</span>
          <span>${n?.lastProbeAt?O(n.lastProbeAt):"n/a"}</span>
        </div>
      </div>

      ${n?.lastError?d`<div class="callout danger" style="margin-top: 12px;">
            ${n.lastError}
          </div>`:g}

      ${n?.probe?d`<div class="callout" style="margin-top: 12px;">
            Probe ${n.probe.ok?"ok":"failed"} ·
            ${n.probe.status??""} ${n.probe.error??""}
          </div>`:g}

      ${_e({channelId:"discord",props:t})}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${()=>t.onRefresh(!0)}>
          Probe
        </button>
      </div>
    </div>
  `}function Up(e){const{props:t,imessage:n,accountCountLabel:s}=e;return d`
    <div class="card">
      <div class="card-title">iMessage</div>
      <div class="card-sub">macOS bridge status and channel configuration.</div>
      ${s}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">Configured</span>
          <span>${n?.configured?"Yes":"No"}</span>
        </div>
        <div>
          <span class="label">Running</span>
          <span>${n?.running?"Yes":"No"}</span>
        </div>
        <div>
          <span class="label">Last start</span>
          <span>${n?.lastStartAt?O(n.lastStartAt):"n/a"}</span>
        </div>
        <div>
          <span class="label">Last probe</span>
          <span>${n?.lastProbeAt?O(n.lastProbeAt):"n/a"}</span>
        </div>
      </div>

      ${n?.lastError?d`<div class="callout danger" style="margin-top: 12px;">
            ${n.lastError}
          </div>`:g}

      ${n?.probe?d`<div class="callout" style="margin-top: 12px;">
            Probe ${n.probe.ok?"ok":"failed"} ·
            ${n.probe.error??""}
          </div>`:g}

      ${_e({channelId:"imessage",props:t})}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${()=>t.onRefresh(!0)}>
          Probe
        </button>
      </div>
    </div>
  `}function Kp(e){const{values:t,original:n}=e;return t.name!==n.name||t.displayName!==n.displayName||t.about!==n.about||t.picture!==n.picture||t.banner!==n.banner||t.website!==n.website||t.nip05!==n.nip05||t.lud16!==n.lud16}function Hp(e){const{state:t,callbacks:n,accountId:s}=e,i=Kp(t),o=(c,r,p={})=>{const{type:l="text",placeholder:u,maxLength:h,help:v}=p,w=t.values[c]??"",$=t.fieldErrors[c],x=`nostr-profile-${c}`;return l==="textarea"?d`
        <div class="form-field" style="margin-bottom: 12px;">
          <label for="${x}" style="display: block; margin-bottom: 4px; font-weight: 500;">
            ${r}
          </label>
          <textarea
            id="${x}"
            .value=${w}
            placeholder=${u??""}
            maxlength=${h??2e3}
            rows="3"
            style="width: 100%; padding: 8px; border: 1px solid var(--border-color); border-radius: 4px; resize: vertical; font-family: inherit;"
            @input=${E=>{const I=E.target;n.onFieldChange(c,I.value)}}
            ?disabled=${t.saving}
          ></textarea>
          ${v?d`<div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">${v}</div>`:g}
          ${$?d`<div style="font-size: 12px; color: var(--danger-color); margin-top: 2px;">${$}</div>`:g}
        </div>
      `:d`
      <div class="form-field" style="margin-bottom: 12px;">
        <label for="${x}" style="display: block; margin-bottom: 4px; font-weight: 500;">
          ${r}
        </label>
        <input
          id="${x}"
          type=${l}
          .value=${w}
          placeholder=${u??""}
          maxlength=${h??256}
          style="width: 100%; padding: 8px; border: 1px solid var(--border-color); border-radius: 4px;"
          @input=${E=>{const I=E.target;n.onFieldChange(c,I.value)}}
          ?disabled=${t.saving}
        />
        ${v?d`<div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">${v}</div>`:g}
        ${$?d`<div style="font-size: 12px; color: var(--danger-color); margin-top: 2px;">${$}</div>`:g}
      </div>
    `},a=()=>{const c=t.values.picture;return c?d`
      <div style="margin-bottom: 12px;">
        <img
          src=${c}
          alt="Profile picture preview"
          style="max-width: 80px; max-height: 80px; border-radius: 50%; object-fit: cover; border: 2px solid var(--border-color);"
          @error=${r=>{const p=r.target;p.style.display="none"}}
          @load=${r=>{const p=r.target;p.style.display="block"}}
        />
      </div>
    `:g};return d`
    <div class="nostr-profile-form" style="padding: 16px; background: var(--bg-secondary); border-radius: 8px; margin-top: 12px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <div style="font-weight: 600; font-size: 16px;">Edit Profile</div>
        <div style="font-size: 12px; color: var(--text-muted);">Account: ${s}</div>
      </div>

      ${t.error?d`<div class="callout danger" style="margin-bottom: 12px;">${t.error}</div>`:g}

      ${t.success?d`<div class="callout success" style="margin-bottom: 12px;">${t.success}</div>`:g}

      ${a()}

      ${o("name","Username",{placeholder:"satoshi",maxLength:256,help:"Short username (e.g., satoshi)"})}

      ${o("displayName","Display Name",{placeholder:"Satoshi Nakamoto",maxLength:256,help:"Your full display name"})}

      ${o("about","Bio",{type:"textarea",placeholder:"Tell people about yourself...",maxLength:2e3,help:"A brief bio or description"})}

      ${o("picture","Avatar URL",{type:"url",placeholder:"https://example.com/avatar.jpg",help:"HTTPS URL to your profile picture"})}

      ${t.showAdvanced?d`
            <div style="border-top: 1px solid var(--border-color); padding-top: 12px; margin-top: 12px;">
              <div style="font-weight: 500; margin-bottom: 12px; color: var(--text-muted);">Advanced</div>

              ${o("banner","Banner URL",{type:"url",placeholder:"https://example.com/banner.jpg",help:"HTTPS URL to a banner image"})}

              ${o("website","Website",{type:"url",placeholder:"https://example.com",help:"Your personal website"})}

              ${o("nip05","NIP-05 Identifier",{placeholder:"you@example.com",help:"Verifiable identifier (e.g., you@domain.com)"})}

              ${o("lud16","Lightning Address",{placeholder:"you@getalby.com",help:"Lightning address for tips (LUD-16)"})}
            </div>
          `:g}

      <div style="display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap;">
        <button
          class="btn primary"
          @click=${n.onSave}
          ?disabled=${t.saving||!i}
        >
          ${t.saving?"Saving...":"Save & Publish"}
        </button>

        <button
          class="btn"
          @click=${n.onImport}
          ?disabled=${t.importing||t.saving}
        >
          ${t.importing?"Importing...":"Import from Relays"}
        </button>

        <button
          class="btn"
          @click=${n.onToggleAdvanced}
        >
          ${t.showAdvanced?"Hide Advanced":"Show Advanced"}
        </button>

        <button
          class="btn"
          @click=${n.onCancel}
          ?disabled=${t.saving}
        >
          Cancel
        </button>
      </div>

      ${i?d`<div style="font-size: 12px; color: var(--warning-color); margin-top: 8px;">
            You have unsaved changes
          </div>`:g}
    </div>
  `}function zp(e){const t={name:e?.name??"",displayName:e?.displayName??"",about:e?.about??"",picture:e?.picture??"",banner:e?.banner??"",website:e?.website??"",nip05:e?.nip05??"",lud16:e?.lud16??""};return{values:t,original:{...t},saving:!1,importing:!1,error:null,success:null,fieldErrors:{},showAdvanced:!!(e?.banner||e?.website||e?.nip05||e?.lud16)}}function Oo(e){return e?e.length<=20?e:`${e.slice(0,8)}...${e.slice(-8)}`:"n/a"}function jp(e){const{props:t,nostr:n,nostrAccounts:s,accountCountLabel:i,profileFormState:o,profileFormCallbacks:a,onEditProfile:c}=e,r=s[0],p=n?.configured??r?.configured??!1,l=n?.running??r?.running??!1,u=n?.publicKey??r?.publicKey,h=n?.lastStartAt??r?.lastStartAt??null,v=n?.lastError??r?.lastError??null,w=s.length>1,$=o!=null,x=I=>{const R=I.publicKey,C=I.profile,A=C?.displayName??C?.name??I.name??I.accountId;return d`
      <div class="account-card">
        <div class="account-card-header">
          <div class="account-card-title">${A}</div>
          <div class="account-card-id">${I.accountId}</div>
        </div>
        <div class="status-list account-card-status">
          <div>
            <span class="label">Running</span>
            <span>${I.running?"Yes":"No"}</span>
          </div>
          <div>
            <span class="label">Configured</span>
            <span>${I.configured?"Yes":"No"}</span>
          </div>
          <div>
            <span class="label">Public Key</span>
            <span class="monospace" title="${R??""}">${Oo(R)}</span>
          </div>
          <div>
            <span class="label">Last inbound</span>
            <span>${I.lastInboundAt?O(I.lastInboundAt):"n/a"}</span>
          </div>
          ${I.lastError?d`
                <div class="account-card-error">${I.lastError}</div>
              `:g}
        </div>
      </div>
    `},E=()=>{if($&&a)return Hp({state:o,callbacks:a,accountId:s[0]?.accountId??"default"});const I=r?.profile??n?.profile,{name:R,displayName:C,about:A,picture:B,nip05:ue}=I??{},bn=R||C||A||B||ue;return d`
      <div style="margin-top: 16px; padding: 12px; background: var(--bg-secondary); border-radius: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <div style="font-weight: 500;">Profile</div>
          ${p?d`
                <button
                  class="btn btn-sm"
                  @click=${c}
                  style="font-size: 12px; padding: 4px 8px;"
                >
                  Edit Profile
                </button>
              `:g}
        </div>
        ${bn?d`
              <div class="status-list">
                ${B?d`
                      <div style="margin-bottom: 8px;">
                        <img
                          src=${B}
                          alt="Profile picture"
                          style="width: 48px; height: 48px; border-radius: 50%; object-fit: cover; border: 2px solid var(--border-color);"
                          @error=${yn=>{yn.target.style.display="none"}}
                        />
                      </div>
                    `:g}
                ${R?d`<div><span class="label">Name</span><span>${R}</span></div>`:g}
                ${C?d`<div><span class="label">Display Name</span><span>${C}</span></div>`:g}
                ${A?d`<div><span class="label">About</span><span style="max-width: 300px; overflow: hidden; text-overflow: ellipsis;">${A}</span></div>`:g}
                ${ue?d`<div><span class="label">NIP-05</span><span>${ue}</span></div>`:g}
              </div>
            `:d`
              <div style="color: var(--text-muted); font-size: 13px;">
                No profile set. Click "Edit Profile" to add your name, bio, and avatar.
              </div>
            `}
      </div>
    `};return d`
    <div class="card">
      <div class="card-title">Nostr</div>
      <div class="card-sub">Decentralized DMs via Nostr relays (NIP-04).</div>
      ${i}

      ${w?d`
            <div class="account-card-list">
              ${s.map(I=>x(I))}
            </div>
          `:d`
            <div class="status-list" style="margin-top: 16px;">
              <div>
                <span class="label">Configured</span>
                <span>${p?"Yes":"No"}</span>
              </div>
              <div>
                <span class="label">Running</span>
                <span>${l?"Yes":"No"}</span>
              </div>
              <div>
                <span class="label">Public Key</span>
                <span class="monospace" title="${u??""}"
                  >${Oo(u)}</span
                >
              </div>
              <div>
                <span class="label">Last start</span>
                <span>${h?O(h):"n/a"}</span>
              </div>
            </div>
          `}

      ${v?d`<div class="callout danger" style="margin-top: 12px;">${v}</div>`:g}

      ${E()}

      ${_e({channelId:"nostr",props:t})}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${()=>t.onRefresh(!1)}>Refresh</button>
      </div>
    </div>
  `}function qp(e){const{props:t,signal:n,accountCountLabel:s}=e;return d`
    <div class="card">
      <div class="card-title">Signal</div>
      <div class="card-sub">signal-cli status and channel configuration.</div>
      ${s}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">Configured</span>
          <span>${n?.configured?"Yes":"No"}</span>
        </div>
        <div>
          <span class="label">Running</span>
          <span>${n?.running?"Yes":"No"}</span>
        </div>
        <div>
          <span class="label">Base URL</span>
          <span>${n?.baseUrl??"n/a"}</span>
        </div>
        <div>
          <span class="label">Last start</span>
          <span>${n?.lastStartAt?O(n.lastStartAt):"n/a"}</span>
        </div>
        <div>
          <span class="label">Last probe</span>
          <span>${n?.lastProbeAt?O(n.lastProbeAt):"n/a"}</span>
        </div>
      </div>

      ${n?.lastError?d`<div class="callout danger" style="margin-top: 12px;">
            ${n.lastError}
          </div>`:g}

      ${n?.probe?d`<div class="callout" style="margin-top: 12px;">
            Probe ${n.probe.ok?"ok":"failed"} ·
            ${n.probe.status??""} ${n.probe.error??""}
          </div>`:g}

      ${_e({channelId:"signal",props:t})}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${()=>t.onRefresh(!0)}>
          Probe
        </button>
      </div>
    </div>
  `}function Wp(e){const{props:t,slack:n,accountCountLabel:s}=e;return d`
    <div class="card">
      <div class="card-title">Slack</div>
      <div class="card-sub">Socket mode status and channel configuration.</div>
      ${s}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">Configured</span>
          <span>${n?.configured?"Yes":"No"}</span>
        </div>
        <div>
          <span class="label">Running</span>
          <span>${n?.running?"Yes":"No"}</span>
        </div>
        <div>
          <span class="label">Last start</span>
          <span>${n?.lastStartAt?O(n.lastStartAt):"n/a"}</span>
        </div>
        <div>
          <span class="label">Last probe</span>
          <span>${n?.lastProbeAt?O(n.lastProbeAt):"n/a"}</span>
        </div>
      </div>

      ${n?.lastError?d`<div class="callout danger" style="margin-top: 12px;">
            ${n.lastError}
          </div>`:g}

      ${n?.probe?d`<div class="callout" style="margin-top: 12px;">
            Probe ${n.probe.ok?"ok":"failed"} ·
            ${n.probe.status??""} ${n.probe.error??""}
          </div>`:g}

      ${_e({channelId:"slack",props:t})}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${()=>t.onRefresh(!0)}>
          Probe
        </button>
      </div>
    </div>
  `}function Vp(e){const{props:t,telegram:n,telegramAccounts:s,accountCountLabel:i}=e,o=s.length>1,a=c=>{const p=c.probe?.bot?.username,l=c.name||c.accountId;return d`
      <div class="account-card">
        <div class="account-card-header">
          <div class="account-card-title">
            ${p?`@${p}`:l}
          </div>
          <div class="account-card-id">${c.accountId}</div>
        </div>
        <div class="status-list account-card-status">
          <div>
            <span class="label">Running</span>
            <span>${c.running?"Yes":"No"}</span>
          </div>
          <div>
            <span class="label">Configured</span>
            <span>${c.configured?"Yes":"No"}</span>
          </div>
          <div>
            <span class="label">Last inbound</span>
            <span>${c.lastInboundAt?O(c.lastInboundAt):"n/a"}</span>
          </div>
          ${c.lastError?d`
                <div class="account-card-error">
                  ${c.lastError}
                </div>
              `:g}
        </div>
      </div>
    `};return d`
    <div class="card">
      <div class="card-title">Telegram</div>
      <div class="card-sub">Bot status and channel configuration.</div>
      ${i}

      ${o?d`
            <div class="account-card-list">
              ${s.map(c=>a(c))}
            </div>
          `:d`
            <div class="status-list" style="margin-top: 16px;">
              <div>
                <span class="label">Configured</span>
                <span>${n?.configured?"Yes":"No"}</span>
              </div>
              <div>
                <span class="label">Running</span>
                <span>${n?.running?"Yes":"No"}</span>
              </div>
              <div>
                <span class="label">Mode</span>
                <span>${n?.mode??"n/a"}</span>
              </div>
              <div>
                <span class="label">Last start</span>
                <span>${n?.lastStartAt?O(n.lastStartAt):"n/a"}</span>
              </div>
              <div>
                <span class="label">Last probe</span>
                <span>${n?.lastProbeAt?O(n.lastProbeAt):"n/a"}</span>
              </div>
            </div>
          `}

      ${n?.lastError?d`<div class="callout danger" style="margin-top: 12px;">
            ${n.lastError}
          </div>`:g}

      ${n?.probe?d`<div class="callout" style="margin-top: 12px;">
            Probe ${n.probe.ok?"ok":"failed"} ·
            ${n.probe.status??""} ${n.probe.error??""}
          </div>`:g}

      ${_e({channelId:"telegram",props:t})}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${()=>t.onRefresh(!0)}>
          Probe
        </button>
      </div>
    </div>
  `}function Gp(e){const{props:t,whatsapp:n,accountCountLabel:s}=e;return d`
    <div class="card">
      <div class="card-title">WhatsApp</div>
      <div class="card-sub">Link WhatsApp Web and monitor connection health.</div>
      ${s}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">Configured</span>
          <span>${n?.configured?"Yes":"No"}</span>
        </div>
        <div>
          <span class="label">Linked</span>
          <span>${n?.linked?"Yes":"No"}</span>
        </div>
        <div>
          <span class="label">Running</span>
          <span>${n?.running?"Yes":"No"}</span>
        </div>
        <div>
          <span class="label">Connected</span>
          <span>${n?.connected?"Yes":"No"}</span>
        </div>
        <div>
          <span class="label">Last connect</span>
          <span>
            ${n?.lastConnectedAt?O(n.lastConnectedAt):"n/a"}
          </span>
        </div>
        <div>
          <span class="label">Last message</span>
          <span>
            ${n?.lastMessageAt?O(n.lastMessageAt):"n/a"}
          </span>
        </div>
        <div>
          <span class="label">Auth age</span>
          <span>
            ${n?.authAgeMs!=null?Mp(n.authAgeMs):"n/a"}
          </span>
        </div>
      </div>

      ${n?.lastError?d`<div class="callout danger" style="margin-top: 12px;">
            ${n.lastError}
          </div>`:g}

      ${t.whatsappMessage?d`<div class="callout" style="margin-top: 12px;">
            ${t.whatsappMessage}
          </div>`:g}

      ${t.whatsappQrDataUrl?d`<div class="qr-wrap">
            <img src=${t.whatsappQrDataUrl} alt="WhatsApp QR" />
          </div>`:g}

      <div class="row" style="margin-top: 14px; flex-wrap: wrap;">
        <button
          class="btn primary"
          ?disabled=${t.whatsappBusy}
          @click=${()=>t.onWhatsAppStart(!1)}
        >
          ${t.whatsappBusy?"Working…":"Show QR"}
        </button>
        <button
          class="btn"
          ?disabled=${t.whatsappBusy}
          @click=${()=>t.onWhatsAppStart(!0)}
        >
          Relink
        </button>
        <button
          class="btn"
          ?disabled=${t.whatsappBusy}
          @click=${()=>t.onWhatsAppWait()}
        >
          Wait for scan
        </button>
        <button
          class="btn danger"
          ?disabled=${t.whatsappBusy}
          @click=${()=>t.onWhatsAppLogout()}
        >
          Logout
        </button>
        <button class="btn" @click=${()=>t.onRefresh(!0)}>
          Refresh
        </button>
      </div>

      ${_e({channelId:"whatsapp",props:t})}
    </div>
  `}function Yp(e){const t=e.snapshot?.channels,n=t?.whatsapp??void 0,s=t?.telegram??void 0,i=t?.discord??null,o=t?.slack??null,a=t?.signal??null,c=t?.imessage??null,r=t?.nostr??null,l=Qp(e.snapshot).map((u,h)=>({key:u,enabled:Pp(u,e),order:h})).sort((u,h)=>u.enabled!==h.enabled?u.enabled?-1:1:u.order-h.order);return d`
    <section class="grid grid-cols-2">
      ${l.map(u=>Jp(u.key,e,{whatsapp:n,telegram:s,discord:i,slack:o,signal:a,imessage:c,nostr:r,channelAccounts:e.snapshot?.channelAccounts??null}))}
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Channel health</div>
          <div class="card-sub">Channel status snapshots from the gateway.</div>
        </div>
        <div class="muted">${e.lastSuccessAt?O(e.lastSuccessAt):"n/a"}</div>
      </div>
      ${e.lastError?d`<div class="callout danger" style="margin-top: 12px;">
            ${e.lastError}
          </div>`:g}
      <pre class="code-block" style="margin-top: 12px;">
${e.snapshot?JSON.stringify(e.snapshot,null,2):"No snapshot yet."}
      </pre>
    </section>
  `}function Qp(e){return e?.channelMeta?.length?e.channelMeta.map(t=>t.id):e?.channelOrder?.length?e.channelOrder:["whatsapp","telegram","discord","slack","signal","imessage","nostr"]}function Jp(e,t,n){const s=lr(e,n.channelAccounts);switch(e){case"whatsapp":return Gp({props:t,whatsapp:n.whatsapp,accountCountLabel:s});case"telegram":return Vp({props:t,telegram:n.telegram,telegramAccounts:n.channelAccounts?.telegram??[],accountCountLabel:s});case"discord":return Fp({props:t,discord:n.discord,accountCountLabel:s});case"slack":return Wp({props:t,slack:n.slack,accountCountLabel:s});case"signal":return qp({props:t,signal:n.signal,accountCountLabel:s});case"imessage":return Up({props:t,imessage:n.imessage,accountCountLabel:s});case"nostr":{const i=n.channelAccounts?.nostr??[],o=i[0],a=o?.accountId??"default",c=o?.profile??null,r=t.nostrProfileAccountId===a?t.nostrProfileFormState:null,p=r?{onFieldChange:t.onNostrProfileFieldChange,onSave:t.onNostrProfileSave,onImport:t.onNostrProfileImport,onCancel:t.onNostrProfileCancel,onToggleAdvanced:t.onNostrProfileToggleAdvanced}:null;return jp({props:t,nostr:n.nostr,nostrAccounts:i,accountCountLabel:s,profileFormState:r,profileFormCallbacks:p,onEditProfile:()=>t.onNostrProfileEdit(a,c)})}default:return Zp(e,t,n.channelAccounts??{})}}function Zp(e,t,n){const s=ef(t.snapshot,e),i=t.snapshot?.channels?.[e],o=typeof i?.configured=="boolean"?i.configured:void 0,a=typeof i?.running=="boolean"?i.running:void 0,c=typeof i?.connected=="boolean"?i.connected:void 0,r=typeof i?.lastError=="string"?i.lastError:void 0,p=n[e]??[],l=lr(e,n);return d`
    <div class="card">
      <div class="card-title">${s}</div>
      <div class="card-sub">Channel status and configuration.</div>
      ${l}

      ${p.length>0?d`
            <div class="account-card-list">
              ${p.map(u=>of(u))}
            </div>
          `:d`
            <div class="status-list" style="margin-top: 16px;">
              <div>
                <span class="label">Configured</span>
                <span>${o==null?"n/a":o?"Yes":"No"}</span>
              </div>
              <div>
                <span class="label">Running</span>
                <span>${a==null?"n/a":a?"Yes":"No"}</span>
              </div>
              <div>
                <span class="label">Connected</span>
                <span>${c==null?"n/a":c?"Yes":"No"}</span>
              </div>
            </div>
          `}

      ${r?d`<div class="callout danger" style="margin-top: 12px;">
            ${r}
          </div>`:g}

      ${_e({channelId:e,props:t})}
    </div>
  `}function Xp(e){return e?.channelMeta?.length?Object.fromEntries(e.channelMeta.map(t=>[t.id,t])):{}}function ef(e,t){return Xp(e)[t]?.label??e?.channelLabels?.[t]??t}const tf=600*1e3;function cr(e){return e.lastInboundAt?Date.now()-e.lastInboundAt<tf:!1}function nf(e){return e.running?"Yes":cr(e)?"Active":"No"}function sf(e){return e.connected===!0?"Yes":e.connected===!1?"No":cr(e)?"Active":"n/a"}function of(e){const t=nf(e),n=sf(e);return d`
    <div class="account-card">
      <div class="account-card-header">
        <div class="account-card-title">${e.name||e.accountId}</div>
        <div class="account-card-id">${e.accountId}</div>
      </div>
      <div class="status-list account-card-status">
        <div>
          <span class="label">Running</span>
          <span>${t}</span>
        </div>
        <div>
          <span class="label">Configured</span>
          <span>${e.configured?"Yes":"No"}</span>
        </div>
        <div>
          <span class="label">Connected</span>
          <span>${n}</span>
        </div>
        <div>
          <span class="label">Last inbound</span>
          <span>${e.lastInboundAt?O(e.lastInboundAt):"n/a"}</span>
        </div>
        ${e.lastError?d`
              <div class="account-card-error">
                ${e.lastError}
              </div>
            `:g}
      </div>
    </div>
  `}function af(e){const t=e.host??"unknown",n=e.ip?`(${e.ip})`:"",s=e.mode??"",i=e.version??"";return`${t} ${n} ${s} ${i}`.trim()}function rf(e){const t=e.ts??null;return t?O(t):"n/a"}function dr(e){return e?`${kt(e)} (${O(e)})`:"n/a"}function lf(e){if(e.totalTokens==null)return"n/a";const t=e.totalTokens??0,n=e.contextTokens??0;return n?`${t} / ${n}`:String(t)}function cf(e){if(e==null)return"";try{return JSON.stringify(e,null,2)}catch{return String(e)}}function df(e){const t=e.state??{},n=t.nextRunAtMs?kt(t.nextRunAtMs):"n/a",s=t.lastRunAtMs?kt(t.lastRunAtMs):"n/a";return`${t.lastStatus??"n/a"} · next ${n} · last ${s}`}function uf(e){const t=e.schedule;return t.kind==="at"?`At ${kt(t.atMs)}`:t.kind==="every"?`Every ${ta(t.everyMs)}`:`Cron ${t.expr}${t.tz?` (${t.tz})`:""}`}function pf(e){const t=e.payload;return t.kind==="systemEvent"?`System: ${t.text}`:`Agent: ${t.message}`}function ff(e){const t=["last",...e.channels.filter(Boolean)],n=e.form.channel?.trim();n&&!t.includes(n)&&t.push(n);const s=new Set;return t.filter(i=>s.has(i)?!1:(s.add(i),!0))}function hf(e,t){if(t==="last")return"last";const n=e.channelMeta?.find(s=>s.id===t);return n?.label?n.label:e.channelLabels?.[t]??t}function gf(e){const t=ff(e);return d`
    <section class="grid grid-cols-2">
      <div class="card">
        <div class="card-title">Scheduler</div>
        <div class="card-sub">Gateway-owned cron scheduler status.</div>
        <div class="stat-grid" style="margin-top: 16px;">
          <div class="stat">
            <div class="stat-label">Enabled</div>
            <div class="stat-value">
              ${e.status?e.status.enabled?"Yes":"No":"n/a"}
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">Jobs</div>
            <div class="stat-value">${e.status?.jobs??"n/a"}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Next wake</div>
            <div class="stat-value">${dr(e.status?.nextWakeAtMs??null)}</div>
          </div>
        </div>
        <div class="row" style="margin-top: 12px;">
          <button class="btn" ?disabled=${e.loading} @click=${e.onRefresh}>
            ${e.loading?"Refreshing…":"Refresh"}
          </button>
          ${e.error?d`<span class="muted">${e.error}</span>`:g}
        </div>
      </div>

      <div class="card">
        <div class="card-title">New Job</div>
        <div class="card-sub">Create a scheduled wakeup or agent run.</div>
        <div class="form-grid" style="margin-top: 16px;">
          <label class="field">
            <span>Name</span>
            <input
              .value=${e.form.name}
              @input=${n=>e.onFormChange({name:n.target.value})}
            />
          </label>
          <label class="field">
            <span>Description</span>
            <input
              .value=${e.form.description}
              @input=${n=>e.onFormChange({description:n.target.value})}
            />
          </label>
          <label class="field">
            <span>Agent ID</span>
            <input
              .value=${e.form.agentId}
              @input=${n=>e.onFormChange({agentId:n.target.value})}
              placeholder="default"
            />
          </label>
          <label class="field checkbox">
            <span>Enabled</span>
            <input
              type="checkbox"
              .checked=${e.form.enabled}
              @change=${n=>e.onFormChange({enabled:n.target.checked})}
            />
          </label>
          <label class="field">
            <span>Schedule</span>
            <select
              .value=${e.form.scheduleKind}
              @change=${n=>e.onFormChange({scheduleKind:n.target.value})}
            >
              <option value="every">Every</option>
              <option value="at">At</option>
              <option value="cron">Cron</option>
            </select>
          </label>
        </div>
        ${vf(e)}
        <div class="form-grid" style="margin-top: 12px;">
          <label class="field">
            <span>Session</span>
            <select
              .value=${e.form.sessionTarget}
              @change=${n=>e.onFormChange({sessionTarget:n.target.value})}
            >
              <option value="main">Main</option>
              <option value="isolated">Isolated</option>
            </select>
          </label>
          <label class="field">
            <span>Wake mode</span>
            <select
              .value=${e.form.wakeMode}
              @change=${n=>e.onFormChange({wakeMode:n.target.value})}
            >
              <option value="next-heartbeat">Next heartbeat</option>
              <option value="now">Now</option>
            </select>
          </label>
          <label class="field">
            <span>Payload</span>
            <select
              .value=${e.form.payloadKind}
              @change=${n=>e.onFormChange({payloadKind:n.target.value})}
            >
              <option value="systemEvent">System event</option>
              <option value="agentTurn">Agent turn</option>
            </select>
          </label>
        </div>
        <label class="field" style="margin-top: 12px;">
          <span>${e.form.payloadKind==="systemEvent"?"System text":"Agent message"}</span>
          <textarea
            .value=${e.form.payloadText}
            @input=${n=>e.onFormChange({payloadText:n.target.value})}
            rows="4"
          ></textarea>
        </label>
	          ${e.form.payloadKind==="agentTurn"?d`
	              <div class="form-grid" style="margin-top: 12px;">
                <label class="field checkbox">
                  <span>Deliver</span>
                  <input
                    type="checkbox"
                    .checked=${e.form.deliver}
                    @change=${n=>e.onFormChange({deliver:n.target.checked})}
                  />
	                </label>
	                <label class="field">
	                  <span>Channel</span>
	                  <select
	                    .value=${e.form.channel||"last"}
	                    @change=${n=>e.onFormChange({channel:n.target.value})}
	                  >
	                    ${t.map(n=>d`<option value=${n}>
                            ${hf(e,n)}
                          </option>`)}
                  </select>
                </label>
                <label class="field">
                  <span>To</span>
                  <input
                    .value=${e.form.to}
                    @input=${n=>e.onFormChange({to:n.target.value})}
                    placeholder="+1555… or chat id"
                  />
                </label>
                <label class="field">
                  <span>Timeout (seconds)</span>
                  <input
                    .value=${e.form.timeoutSeconds}
                    @input=${n=>e.onFormChange({timeoutSeconds:n.target.value})}
                  />
                </label>
                ${e.form.sessionTarget==="isolated"?d`
                      <label class="field">
                        <span>Post to main prefix</span>
                        <input
                          .value=${e.form.postToMainPrefix}
                          @input=${n=>e.onFormChange({postToMainPrefix:n.target.value})}
                        />
                      </label>
                    `:g}
              </div>
            `:g}
        <div class="row" style="margin-top: 14px;">
          <button class="btn primary" ?disabled=${e.busy} @click=${e.onAdd}>
            ${e.busy?"Saving…":"Add job"}
          </button>
        </div>
      </div>
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">Jobs</div>
      <div class="card-sub">All scheduled jobs stored in the gateway.</div>
      ${e.jobs.length===0?d`<div class="muted" style="margin-top: 12px;">No jobs yet.</div>`:d`
            <div class="list" style="margin-top: 12px;">
              ${e.jobs.map(n=>mf(n,e))}
            </div>
          `}
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">Run history</div>
      <div class="card-sub">Latest runs for ${e.runsJobId??"(select a job)"}.</div>
      ${e.runsJobId==null?d`
            <div class="muted" style="margin-top: 12px;">
              Select a job to inspect run history.
            </div>
          `:e.runs.length===0?d`<div class="muted" style="margin-top: 12px;">No runs yet.</div>`:d`
              <div class="list" style="margin-top: 12px;">
                ${e.runs.map(n=>bf(n))}
              </div>
            `}
    </section>
  `}function vf(e){const t=e.form;return t.scheduleKind==="at"?d`
      <label class="field" style="margin-top: 12px;">
        <span>Run at</span>
        <input
          type="datetime-local"
          .value=${t.scheduleAt}
          @input=${n=>e.onFormChange({scheduleAt:n.target.value})}
        />
      </label>
    `:t.scheduleKind==="every"?d`
      <div class="form-grid" style="margin-top: 12px;">
        <label class="field">
          <span>Every</span>
          <input
            .value=${t.everyAmount}
            @input=${n=>e.onFormChange({everyAmount:n.target.value})}
          />
        </label>
        <label class="field">
          <span>Unit</span>
          <select
            .value=${t.everyUnit}
            @change=${n=>e.onFormChange({everyUnit:n.target.value})}
          >
            <option value="minutes">Minutes</option>
            <option value="hours">Hours</option>
            <option value="days">Days</option>
          </select>
        </label>
      </div>
    `:d`
    <div class="form-grid" style="margin-top: 12px;">
      <label class="field">
        <span>Expression</span>
        <input
          .value=${t.cronExpr}
          @input=${n=>e.onFormChange({cronExpr:n.target.value})}
        />
      </label>
      <label class="field">
        <span>Timezone (optional)</span>
        <input
          .value=${t.cronTz}
          @input=${n=>e.onFormChange({cronTz:n.target.value})}
        />
      </label>
    </div>
  `}function mf(e,t){const s=`list-item list-item-clickable${t.runsJobId===e.id?" list-item-selected":""}`;return d`
    <div class=${s} @click=${()=>t.onLoadRuns(e.id)}>
      <div class="list-main">
        <div class="list-title">${e.name}</div>
        <div class="list-sub">${uf(e)}</div>
        <div class="muted">${pf(e)}</div>
        ${e.agentId?d`<div class="muted">Agent: ${e.agentId}</div>`:g}
        <div class="chip-row" style="margin-top: 6px;">
          <span class="chip">${e.enabled?"enabled":"disabled"}</span>
          <span class="chip">${e.sessionTarget}</span>
          <span class="chip">${e.wakeMode}</span>
        </div>
      </div>
      <div class="list-meta">
        <div>${df(e)}</div>
        <div class="row" style="justify-content: flex-end; margin-top: 8px;">
          <button
            class="btn"
            ?disabled=${t.busy}
            @click=${i=>{i.stopPropagation(),t.onToggle(e,!e.enabled)}}
          >
            ${e.enabled?"Disable":"Enable"}
          </button>
          <button
            class="btn"
            ?disabled=${t.busy}
            @click=${i=>{i.stopPropagation(),t.onRun(e)}}
          >
            Run
          </button>
          <button
            class="btn"
            ?disabled=${t.busy}
            @click=${i=>{i.stopPropagation(),t.onLoadRuns(e.id)}}
          >
            Runs
          </button>
          <button
            class="btn danger"
            ?disabled=${t.busy}
            @click=${i=>{i.stopPropagation(),t.onRemove(e)}}
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  `}function bf(e){return d`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${e.status}</div>
        <div class="list-sub">${e.summary??""}</div>
      </div>
      <div class="list-meta">
        <div>${kt(e.ts)}</div>
        <div class="muted">${e.durationMs??0}ms</div>
        ${e.error?d`<div class="muted">${e.error}</div>`:g}
      </div>
    </div>
  `}function yf(e){return d`
    <section class="grid grid-cols-2">
      <div class="card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">Snapshots</div>
            <div class="card-sub">Status, health, and heartbeat data.</div>
          </div>
          <button class="btn" ?disabled=${e.loading} @click=${e.onRefresh}>
            ${e.loading?"Refreshing…":"Refresh"}
          </button>
        </div>
        <div class="stack" style="margin-top: 12px;">
          <div>
            <div class="muted">Status</div>
            <pre class="code-block">${JSON.stringify(e.status??{},null,2)}</pre>
          </div>
          <div>
            <div class="muted">Health</div>
            <pre class="code-block">${JSON.stringify(e.health??{},null,2)}</pre>
          </div>
          <div>
            <div class="muted">Last heartbeat</div>
            <pre class="code-block">${JSON.stringify(e.heartbeat??{},null,2)}</pre>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Manual RPC</div>
        <div class="card-sub">Send a raw gateway method with JSON params.</div>
        <div class="form-grid" style="margin-top: 16px;">
          <label class="field">
            <span>Method</span>
            <input
              .value=${e.callMethod}
              @input=${t=>e.onCallMethodChange(t.target.value)}
              placeholder="system-presence"
            />
          </label>
          <label class="field">
            <span>Params (JSON)</span>
            <textarea
              .value=${e.callParams}
              @input=${t=>e.onCallParamsChange(t.target.value)}
              rows="6"
            ></textarea>
          </label>
        </div>
        <div class="row" style="margin-top: 12px;">
          <button class="btn primary" @click=${e.onCall}>Call</button>
        </div>
        ${e.callError?d`<div class="callout danger" style="margin-top: 12px;">
              ${e.callError}
            </div>`:g}
        ${e.callResult?d`<pre class="code-block" style="margin-top: 12px;">${e.callResult}</pre>`:g}
      </div>
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">Models</div>
      <div class="card-sub">Catalog from models.list.</div>
      <pre class="code-block" style="margin-top: 12px;">${JSON.stringify(e.models??[],null,2)}</pre>
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">Event Log</div>
      <div class="card-sub">Latest gateway events.</div>
      ${e.eventLog.length===0?d`<div class="muted" style="margin-top: 12px;">No events yet.</div>`:d`
            <div class="list" style="margin-top: 12px;">
              ${e.eventLog.map(t=>d`
                  <div class="list-item">
                    <div class="list-main">
                      <div class="list-title">${t.event}</div>
                      <div class="list-sub">${new Date(t.ts).toLocaleTimeString()}</div>
                    </div>
                    <div class="list-meta">
                      <pre class="code-block">${cf(t.payload)}</pre>
                    </div>
                  </div>
                `)}
            </div>
          `}
    </section>
  `}function wf(e){return d`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Connected Instances</div>
          <div class="card-sub">Presence beacons from the gateway and clients.</div>
        </div>
        <button class="btn" ?disabled=${e.loading} @click=${e.onRefresh}>
          ${e.loading?"Loading…":"Refresh"}
        </button>
      </div>
      ${e.lastError?d`<div class="callout danger" style="margin-top: 12px;">
            ${e.lastError}
          </div>`:g}
      ${e.statusMessage?d`<div class="callout" style="margin-top: 12px;">
            ${e.statusMessage}
          </div>`:g}
      <div class="list" style="margin-top: 16px;">
        ${e.entries.length===0?d`<div class="muted">No instances reported yet.</div>`:e.entries.map(t=>$f(t))}
      </div>
    </section>
  `}function $f(e){const t=e.lastInputSeconds!=null?`${e.lastInputSeconds}s ago`:"n/a",n=e.mode??"unknown",s=Array.isArray(e.roles)?e.roles.filter(Boolean):[],i=Array.isArray(e.scopes)?e.scopes.filter(Boolean):[],o=i.length>0?i.length>3?`${i.length} scopes`:`scopes: ${i.join(", ")}`:null;return d`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${e.host??"unknown host"}</div>
        <div class="list-sub">${af(e)}</div>
        <div class="chip-row">
          <span class="chip">${n}</span>
          ${s.map(a=>d`<span class="chip">${a}</span>`)}
          ${o?d`<span class="chip">${o}</span>`:g}
          ${e.platform?d`<span class="chip">${e.platform}</span>`:g}
          ${e.deviceFamily?d`<span class="chip">${e.deviceFamily}</span>`:g}
          ${e.modelIdentifier?d`<span class="chip">${e.modelIdentifier}</span>`:g}
          ${e.version?d`<span class="chip">${e.version}</span>`:g}
        </div>
      </div>
      <div class="list-meta">
        <div>${rf(e)}</div>
        <div class="muted">Last input ${t}</div>
        <div class="muted">Reason ${e.reason??""}</div>
      </div>
    </div>
  `}const Do=["trace","debug","info","warn","error","fatal"];function kf(e){if(!e)return"";const t=new Date(e);return Number.isNaN(t.getTime())?e:t.toLocaleTimeString()}function xf(e,t){return t?[e.message,e.subsystem,e.raw].filter(Boolean).join(" ").toLowerCase().includes(t):!0}function Af(e){const t=e.filterText.trim().toLowerCase(),n=Do.some(o=>!e.levelFilters[o]),s=e.entries.filter(o=>o.level&&!e.levelFilters[o.level]?!1:xf(o,t)),i=t||n?"filtered":"visible";return d`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Logs</div>
          <div class="card-sub">Gateway file logs (JSONL).</div>
        </div>
        <div class="row" style="gap: 8px;">
          <button class="btn" ?disabled=${e.loading} @click=${e.onRefresh}>
            ${e.loading?"Loading…":"Refresh"}
          </button>
          <button
            class="btn"
            ?disabled=${s.length===0}
            @click=${()=>e.onExport(s.map(o=>o.raw),i)}
          >
            Export ${i}
          </button>
        </div>
      </div>

      <div class="filters" style="margin-top: 14px;">
        <label class="field" style="min-width: 220px;">
          <span>Filter</span>
          <input
            .value=${e.filterText}
            @input=${o=>e.onFilterTextChange(o.target.value)}
            placeholder="Search logs"
          />
        </label>
        <label class="field checkbox">
          <span>Auto-follow</span>
          <input
            type="checkbox"
            .checked=${e.autoFollow}
            @change=${o=>e.onToggleAutoFollow(o.target.checked)}
          />
        </label>
      </div>

      <div class="chip-row" style="margin-top: 12px;">
        ${Do.map(o=>d`
            <label class="chip log-chip ${o}">
              <input
                type="checkbox"
                .checked=${e.levelFilters[o]}
                @change=${a=>e.onLevelToggle(o,a.target.checked)}
              />
              <span>${o}</span>
            </label>
          `)}
      </div>

      ${e.file?d`<div class="muted" style="margin-top: 10px;">File: ${e.file}</div>`:g}
      ${e.truncated?d`<div class="callout" style="margin-top: 10px;">
            Log output truncated; showing latest chunk.
          </div>`:g}
      ${e.error?d`<div class="callout danger" style="margin-top: 10px;">${e.error}</div>`:g}

      <div class="log-stream" style="margin-top: 12px;" @scroll=${e.onScroll}>
        ${s.length===0?d`<div class="muted" style="padding: 12px;">No log entries.</div>`:s.map(o=>d`
                <div class="log-row">
                  <div class="log-time mono">${kf(o.time)}</div>
                  <div class="log-level ${o.level??""}">${o.level??""}</div>
                  <div class="log-subsystem mono">${o.subsystem??""}</div>
                  <div class="log-message mono">${o.message??o.raw}</div>
                </div>
              `)}
      </div>
    </section>
  `}function Sf(e){const t=Lf(e),n=Df(e);return d`
    ${Ff(n)}
    ${Bf(t)}
    ${_f(e)}
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Nodes</div>
          <div class="card-sub">Paired devices and live links.</div>
        </div>
        <button class="btn" ?disabled=${e.loading} @click=${e.onRefresh}>
          ${e.loading?"Loading…":"Refresh"}
        </button>
      </div>
      <div class="list" style="margin-top: 16px;">
        ${e.nodes.length===0?d`<div class="muted">No nodes found.</div>`:e.nodes.map(s=>Yf(s))}
      </div>
    </section>
  `}function _f(e){const t=e.devicesList??{pending:[],paired:[]},n=Array.isArray(t.pending)?t.pending:[],s=Array.isArray(t.paired)?t.paired:[];return d`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Devices</div>
          <div class="card-sub">Pairing requests + role tokens.</div>
        </div>
        <button class="btn" ?disabled=${e.devicesLoading} @click=${e.onDevicesRefresh}>
          ${e.devicesLoading?"Loading…":"Refresh"}
        </button>
      </div>
      ${e.devicesError?d`<div class="callout danger" style="margin-top: 12px;">${e.devicesError}</div>`:g}
      <div class="list" style="margin-top: 16px;">
        ${n.length>0?d`
              <div class="muted" style="margin-bottom: 8px;">Pending</div>
              ${n.map(i=>Tf(i,e))}
            `:g}
        ${s.length>0?d`
              <div class="muted" style="margin-top: 12px; margin-bottom: 8px;">Paired</div>
              ${s.map(i=>Ef(i,e))}
            `:g}
        ${n.length===0&&s.length===0?d`<div class="muted">No paired devices.</div>`:g}
      </div>
    </section>
  `}function Tf(e,t){const n=e.displayName?.trim()||e.deviceId,s=typeof e.ts=="number"?O(e.ts):"n/a",i=e.role?.trim()?`role: ${e.role}`:"role: -",o=e.isRepair?" · repair":"",a=e.remoteIp?` · ${e.remoteIp}`:"";return d`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${n}</div>
        <div class="list-sub">${e.deviceId}${a}</div>
        <div class="muted" style="margin-top: 6px;">
          ${i} · requested ${s}${o}
        </div>
      </div>
      <div class="list-meta">
        <div class="row" style="justify-content: flex-end; gap: 8px; flex-wrap: wrap;">
          <button class="btn btn--sm primary" @click=${()=>t.onDeviceApprove(e.requestId)}>
            Approve
          </button>
          <button class="btn btn--sm" @click=${()=>t.onDeviceReject(e.requestId)}>
            Reject
          </button>
        </div>
      </div>
    </div>
  `}function Ef(e,t){const n=e.displayName?.trim()||e.deviceId,s=e.remoteIp?` · ${e.remoteIp}`:"",i=`roles: ${ns(e.roles)}`,o=`scopes: ${ns(e.scopes)}`,a=Array.isArray(e.tokens)?e.tokens:[];return d`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${n}</div>
        <div class="list-sub">${e.deviceId}${s}</div>
        <div class="muted" style="margin-top: 6px;">${i} · ${o}</div>
        ${a.length===0?d`<div class="muted" style="margin-top: 6px;">Tokens: none</div>`:d`
              <div class="muted" style="margin-top: 10px;">Tokens</div>
              <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 6px;">
                ${a.map(c=>Cf(e.deviceId,c,t))}
              </div>
            `}
      </div>
    </div>
  `}function Cf(e,t,n){const s=t.revokedAtMs?"revoked":"active",i=`scopes: ${ns(t.scopes)}`,o=O(t.rotatedAtMs??t.createdAtMs??t.lastUsedAtMs??null);return d`
    <div class="row" style="justify-content: space-between; gap: 8px;">
      <div class="list-sub">${t.role} · ${s} · ${i} · ${o}</div>
      <div class="row" style="justify-content: flex-end; gap: 6px; flex-wrap: wrap;">
        <button
          class="btn btn--sm"
          @click=${()=>n.onDeviceRotate(e,t.role,t.scopes)}
        >
          Rotate
        </button>
        ${t.revokedAtMs?g:d`
              <button
                class="btn btn--sm danger"
                @click=${()=>n.onDeviceRevoke(e,t.role)}
              >
                Revoke
              </button>
            `}
      </div>
    </div>
  `}const ke="__defaults__",Bo=[{value:"deny",label:"Deny"},{value:"allowlist",label:"Allowlist"},{value:"full",label:"Full"}],If=[{value:"off",label:"Off"},{value:"on-miss",label:"On miss"},{value:"always",label:"Always"}];function Lf(e){const t=e.configForm,n=Wf(e.nodes),{defaultBinding:s,agents:i}=Gf(t),o=!!t,a=e.configSaving||e.configFormMode==="raw";return{ready:o,disabled:a,configDirty:e.configDirty,configLoading:e.configLoading,configSaving:e.configSaving,defaultBinding:s,agents:i,nodes:n,onBindDefault:e.onBindDefault,onBindAgent:e.onBindAgent,onSave:e.onSaveBindings,onLoadConfig:e.onLoadConfig,formMode:e.configFormMode}}function Fo(e){return e==="allowlist"||e==="full"||e==="deny"?e:"deny"}function Rf(e){return e==="always"||e==="off"||e==="on-miss"?e:"on-miss"}function Mf(e){const t=e?.defaults??{};return{security:Fo(t.security),ask:Rf(t.ask),askFallback:Fo(t.askFallback??"deny"),autoAllowSkills:!!(t.autoAllowSkills??!1)}}function Pf(e){const t=e?.agents??{},n=Array.isArray(t.list)?t.list:[],s=[];return n.forEach(i=>{if(!i||typeof i!="object")return;const o=i,a=typeof o.id=="string"?o.id.trim():"";if(!a)return;const c=typeof o.name=="string"?o.name.trim():void 0,r=o.default===!0;s.push({id:a,name:c||void 0,isDefault:r})}),s}function Nf(e,t){const n=Pf(e),s=Object.keys(t?.agents??{}),i=new Map;n.forEach(a=>i.set(a.id,a)),s.forEach(a=>{i.has(a)||i.set(a,{id:a})});const o=Array.from(i.values());return o.length===0&&o.push({id:"main",isDefault:!0}),o.sort((a,c)=>{if(a.isDefault&&!c.isDefault)return-1;if(!a.isDefault&&c.isDefault)return 1;const r=a.name?.trim()?a.name:a.id,p=c.name?.trim()?c.name:c.id;return r.localeCompare(p)}),o}function Of(e,t){return e===ke?ke:e&&t.some(n=>n.id===e)?e:ke}function Df(e){const t=e.execApprovalsForm??e.execApprovalsSnapshot?.file??null,n=!!t,s=Mf(t),i=Nf(e.configForm,t),o=Vf(e.nodes),a=e.execApprovalsTarget;let c=a==="node"&&e.execApprovalsTargetNodeId?e.execApprovalsTargetNodeId:null;a==="node"&&c&&!o.some(u=>u.id===c)&&(c=null);const r=Of(e.execApprovalsSelectedAgent,i),p=r!==ke?(t?.agents??{})[r]??null:null,l=Array.isArray(p?.allowlist)?p.allowlist??[]:[];return{ready:n,disabled:e.execApprovalsSaving||e.execApprovalsLoading,dirty:e.execApprovalsDirty,loading:e.execApprovalsLoading,saving:e.execApprovalsSaving,form:t,defaults:s,selectedScope:r,selectedAgent:p,agents:i,allowlist:l,target:a,targetNodeId:c,targetNodes:o,onSelectScope:e.onExecApprovalsSelectAgent,onSelectTarget:e.onExecApprovalsTargetChange,onPatch:e.onExecApprovalsPatch,onRemove:e.onExecApprovalsRemove,onLoad:e.onLoadExecApprovals,onSave:e.onSaveExecApprovals}}function Bf(e){const t=e.nodes.length>0,n=e.defaultBinding??"";return d`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: center;">
        <div>
          <div class="card-title">Exec node binding</div>
          <div class="card-sub">
            Pin agents to a specific node when using <span class="mono">exec host=node</span>.
          </div>
        </div>
        <button
          class="btn"
          ?disabled=${e.disabled||!e.configDirty}
          @click=${e.onSave}
        >
          ${e.configSaving?"Saving…":"Save"}
        </button>
      </div>

      ${e.formMode==="raw"?d`<div class="callout warn" style="margin-top: 12px;">
            Switch the Config tab to <strong>Form</strong> mode to edit bindings here.
          </div>`:g}

      ${e.ready?d`
            <div class="list" style="margin-top: 16px;">
              <div class="list-item">
                <div class="list-main">
                  <div class="list-title">Default binding</div>
                  <div class="list-sub">Used when agents do not override a node binding.</div>
                </div>
                <div class="list-meta">
                  <label class="field">
                    <span>Node</span>
                    <select
                      ?disabled=${e.disabled||!t}
                      @change=${s=>{const o=s.target.value.trim();e.onBindDefault(o||null)}}
                    >
                      <option value="" ?selected=${n===""}>Any node</option>
                      ${e.nodes.map(s=>d`<option
                            value=${s.id}
                            ?selected=${n===s.id}
                          >
                            ${s.label}
                          </option>`)}
                    </select>
                  </label>
                  ${t?g:d`<div class="muted">No nodes with system.run available.</div>`}
                </div>
              </div>

              ${e.agents.length===0?d`<div class="muted">No agents found.</div>`:e.agents.map(s=>qf(s,e))}
            </div>
          `:d`<div class="row" style="margin-top: 12px; gap: 12px;">
            <div class="muted">Load config to edit bindings.</div>
            <button class="btn" ?disabled=${e.configLoading} @click=${e.onLoadConfig}>
              ${e.configLoading?"Loading…":"Load config"}
            </button>
          </div>`}
    </section>
  `}function Ff(e){const t=e.ready,n=e.target!=="node"||!!e.targetNodeId;return d`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: center;">
        <div>
          <div class="card-title">Exec approvals</div>
          <div class="card-sub">
            Allowlist and approval policy for <span class="mono">exec host=gateway/node</span>.
          </div>
        </div>
        <button
          class="btn"
          ?disabled=${e.disabled||!e.dirty||!n}
          @click=${e.onSave}
        >
          ${e.saving?"Saving…":"Save"}
        </button>
      </div>

      ${Uf(e)}

      ${t?d`
            ${Kf(e)}
            ${Hf(e)}
            ${e.selectedScope===ke?g:zf(e)}
          `:d`<div class="row" style="margin-top: 12px; gap: 12px;">
            <div class="muted">Load exec approvals to edit allowlists.</div>
            <button class="btn" ?disabled=${e.loading||!n} @click=${e.onLoad}>
              ${e.loading?"Loading…":"Load approvals"}
            </button>
          </div>`}
    </section>
  `}function Uf(e){const t=e.targetNodes.length>0,n=e.targetNodeId??"";return d`
    <div class="list" style="margin-top: 12px;">
      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Target</div>
          <div class="list-sub">
            Gateway edits local approvals; node edits the selected node.
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Host</span>
            <select
              ?disabled=${e.disabled}
              @change=${s=>{if(s.target.value==="node"){const a=e.targetNodes[0]?.id??null;e.onSelectTarget("node",n||a)}else e.onSelectTarget("gateway",null)}}
            >
              <option value="gateway" ?selected=${e.target==="gateway"}>Gateway</option>
              <option value="node" ?selected=${e.target==="node"}>Node</option>
            </select>
          </label>
          ${e.target==="node"?d`
                <label class="field">
                  <span>Node</span>
                  <select
                    ?disabled=${e.disabled||!t}
                    @change=${s=>{const o=s.target.value.trim();e.onSelectTarget("node",o||null)}}
                  >
                    <option value="" ?selected=${n===""}>Select node</option>
                    ${e.targetNodes.map(s=>d`<option
                          value=${s.id}
                          ?selected=${n===s.id}
                        >
                          ${s.label}
                        </option>`)}
                  </select>
                </label>
              `:g}
        </div>
      </div>
      ${e.target==="node"&&!t?d`<div class="muted">No nodes advertise exec approvals yet.</div>`:g}
    </div>
  `}function Kf(e){return d`
    <div class="row" style="margin-top: 12px; gap: 8px; flex-wrap: wrap;">
      <span class="label">Scope</span>
      <div class="row" style="gap: 8px; flex-wrap: wrap;">
        <button
          class="btn btn--sm ${e.selectedScope===ke?"active":""}"
          @click=${()=>e.onSelectScope(ke)}
        >
          Defaults
        </button>
        ${e.agents.map(t=>{const n=t.name?.trim()?`${t.name} (${t.id})`:t.id;return d`
            <button
              class="btn btn--sm ${e.selectedScope===t.id?"active":""}"
              @click=${()=>e.onSelectScope(t.id)}
            >
              ${n}
            </button>
          `})}
      </div>
    </div>
  `}function Hf(e){const t=e.selectedScope===ke,n=e.defaults,s=e.selectedAgent??{},i=t?["defaults"]:["agents",e.selectedScope],o=typeof s.security=="string"?s.security:void 0,a=typeof s.ask=="string"?s.ask:void 0,c=typeof s.askFallback=="string"?s.askFallback:void 0,r=t?n.security:o??"__default__",p=t?n.ask:a??"__default__",l=t?n.askFallback:c??"__default__",u=typeof s.autoAllowSkills=="boolean"?s.autoAllowSkills:void 0,h=u??n.autoAllowSkills,v=u==null;return d`
    <div class="list" style="margin-top: 16px;">
      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Security</div>
          <div class="list-sub">
            ${t?"Default security mode.":`Default: ${n.security}.`}
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Mode</span>
            <select
              ?disabled=${e.disabled}
              @change=${w=>{const x=w.target.value;!t&&x==="__default__"?e.onRemove([...i,"security"]):e.onPatch([...i,"security"],x)}}
            >
              ${t?g:d`<option value="__default__" ?selected=${r==="__default__"}>
                    Use default (${n.security})
                  </option>`}
              ${Bo.map(w=>d`<option
                    value=${w.value}
                    ?selected=${r===w.value}
                  >
                    ${w.label}
                  </option>`)}
            </select>
          </label>
        </div>
      </div>

      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Ask</div>
          <div class="list-sub">
            ${t?"Default prompt policy.":`Default: ${n.ask}.`}
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Mode</span>
            <select
              ?disabled=${e.disabled}
              @change=${w=>{const x=w.target.value;!t&&x==="__default__"?e.onRemove([...i,"ask"]):e.onPatch([...i,"ask"],x)}}
            >
              ${t?g:d`<option value="__default__" ?selected=${p==="__default__"}>
                    Use default (${n.ask})
                  </option>`}
              ${If.map(w=>d`<option
                    value=${w.value}
                    ?selected=${p===w.value}
                  >
                    ${w.label}
                  </option>`)}
            </select>
          </label>
        </div>
      </div>

      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Ask fallback</div>
          <div class="list-sub">
            ${t?"Applied when the UI prompt is unavailable.":`Default: ${n.askFallback}.`}
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Fallback</span>
            <select
              ?disabled=${e.disabled}
              @change=${w=>{const x=w.target.value;!t&&x==="__default__"?e.onRemove([...i,"askFallback"]):e.onPatch([...i,"askFallback"],x)}}
            >
              ${t?g:d`<option value="__default__" ?selected=${l==="__default__"}>
                    Use default (${n.askFallback})
                  </option>`}
              ${Bo.map(w=>d`<option
                    value=${w.value}
                    ?selected=${l===w.value}
                  >
                    ${w.label}
                  </option>`)}
            </select>
          </label>
        </div>
      </div>

      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Auto-allow skill CLIs</div>
          <div class="list-sub">
            ${t?"Allow skill executables listed by the Gateway.":v?`Using default (${n.autoAllowSkills?"on":"off"}).`:`Override (${h?"on":"off"}).`}
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Enabled</span>
            <input
              type="checkbox"
              ?disabled=${e.disabled}
              .checked=${h}
              @change=${w=>{const $=w.target;e.onPatch([...i,"autoAllowSkills"],$.checked)}}
            />
          </label>
          ${!t&&!v?d`<button
                class="btn btn--sm"
                ?disabled=${e.disabled}
                @click=${()=>e.onRemove([...i,"autoAllowSkills"])}
              >
                Use default
              </button>`:g}
        </div>
      </div>
    </div>
  `}function zf(e){const t=["agents",e.selectedScope,"allowlist"],n=e.allowlist;return d`
    <div class="row" style="margin-top: 18px; justify-content: space-between;">
      <div>
        <div class="card-title">Allowlist</div>
        <div class="card-sub">Case-insensitive glob patterns.</div>
      </div>
      <button
        class="btn btn--sm"
        ?disabled=${e.disabled}
        @click=${()=>{const s=[...n,{pattern:""}];e.onPatch(t,s)}}
      >
        Add pattern
      </button>
    </div>
    <div class="list" style="margin-top: 12px;">
      ${n.length===0?d`<div class="muted">No allowlist entries yet.</div>`:n.map((s,i)=>jf(e,s,i))}
    </div>
  `}function jf(e,t,n){const s=t.lastUsedAt?O(t.lastUsedAt):"never",i=t.lastUsedCommand?ss(t.lastUsedCommand,120):null,o=t.lastResolvedPath?ss(t.lastResolvedPath,120):null;return d`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${t.pattern?.trim()?t.pattern:"New pattern"}</div>
        <div class="list-sub">Last used: ${s}</div>
        ${i?d`<div class="list-sub mono">${i}</div>`:g}
        ${o?d`<div class="list-sub mono">${o}</div>`:g}
      </div>
      <div class="list-meta">
        <label class="field">
          <span>Pattern</span>
          <input
            type="text"
            .value=${t.pattern??""}
            ?disabled=${e.disabled}
            @input=${a=>{const c=a.target;e.onPatch(["agents",e.selectedScope,"allowlist",n,"pattern"],c.value)}}
          />
        </label>
        <button
          class="btn btn--sm danger"
          ?disabled=${e.disabled}
          @click=${()=>{if(e.allowlist.length<=1){e.onRemove(["agents",e.selectedScope,"allowlist"]);return}e.onRemove(["agents",e.selectedScope,"allowlist",n])}}
        >
          Remove
        </button>
      </div>
    </div>
  `}function qf(e,t){const n=e.binding??"__default__",s=e.name?.trim()?`${e.name} (${e.id})`:e.id,i=t.nodes.length>0;return d`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${s}</div>
        <div class="list-sub">
          ${e.isDefault?"default agent":"agent"} ·
          ${n==="__default__"?`uses default (${t.defaultBinding??"any"})`:`override: ${e.binding}`}
        </div>
      </div>
      <div class="list-meta">
        <label class="field">
          <span>Binding</span>
          <select
            ?disabled=${t.disabled||!i}
            @change=${o=>{const c=o.target.value.trim();t.onBindAgent(e.index,c==="__default__"?null:c)}}
          >
            <option value="__default__" ?selected=${n==="__default__"}>
              Use default
            </option>
            ${t.nodes.map(o=>d`<option
                  value=${o.id}
                  ?selected=${n===o.id}
                >
                  ${o.label}
                </option>`)}
          </select>
        </label>
      </div>
    </div>
  `}function Wf(e){const t=[];for(const n of e){if(!(Array.isArray(n.commands)?n.commands:[]).some(c=>String(c)==="system.run"))continue;const o=typeof n.nodeId=="string"?n.nodeId.trim():"";if(!o)continue;const a=typeof n.displayName=="string"&&n.displayName.trim()?n.displayName.trim():o;t.push({id:o,label:a===o?o:`${a} · ${o}`})}return t.sort((n,s)=>n.label.localeCompare(s.label)),t}function Vf(e){const t=[];for(const n of e){if(!(Array.isArray(n.commands)?n.commands:[]).some(c=>String(c)==="system.execApprovals.get"||String(c)==="system.execApprovals.set"))continue;const o=typeof n.nodeId=="string"?n.nodeId.trim():"";if(!o)continue;const a=typeof n.displayName=="string"&&n.displayName.trim()?n.displayName.trim():o;t.push({id:o,label:a===o?o:`${a} · ${o}`})}return t.sort((n,s)=>n.label.localeCompare(s.label)),t}function Gf(e){const t={id:"main",name:void 0,index:0,isDefault:!0,binding:null};if(!e||typeof e!="object")return{defaultBinding:null,agents:[t]};const s=(e.tools??{}).exec??{},i=typeof s.node=="string"&&s.node.trim()?s.node.trim():null,o=e.agents??{},a=Array.isArray(o.list)?o.list:[];if(a.length===0)return{defaultBinding:i,agents:[t]};const c=[];return a.forEach((r,p)=>{if(!r||typeof r!="object")return;const l=r,u=typeof l.id=="string"?l.id.trim():"";if(!u)return;const h=typeof l.name=="string"?l.name.trim():void 0,v=l.default===!0,$=(l.tools??{}).exec??{},x=typeof $.node=="string"&&$.node.trim()?$.node.trim():null;c.push({id:u,name:h||void 0,index:p,isDefault:v,binding:x})}),c.length===0&&c.push(t),{defaultBinding:i,agents:c}}function Yf(e){const t=!!e.connected,n=!!e.paired,s=typeof e.displayName=="string"&&e.displayName.trim()||(typeof e.nodeId=="string"?e.nodeId:"unknown"),i=Array.isArray(e.caps)?e.caps:[],o=Array.isArray(e.commands)?e.commands:[];return d`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${s}</div>
        <div class="list-sub">
          ${typeof e.nodeId=="string"?e.nodeId:""}
          ${typeof e.remoteIp=="string"?` · ${e.remoteIp}`:""}
          ${typeof e.version=="string"?` · ${e.version}`:""}
        </div>
        <div class="chip-row" style="margin-top: 6px;">
          <span class="chip">${n?"paired":"unpaired"}</span>
          <span class="chip ${t?"chip-ok":"chip-warn"}">
            ${t?"connected":"offline"}
          </span>
          ${i.slice(0,12).map(a=>d`<span class="chip">${String(a)}</span>`)}
          ${o.slice(0,8).map(a=>d`<span class="chip">${String(a)}</span>`)}
        </div>
      </div>
    </div>
  `}function Qf(e){const t=e.hello?.snapshot,n=t?.uptimeMs?ta(t.uptimeMs):"n/a",s=t?.policy?.tickIntervalMs?`${t.policy.tickIntervalMs}ms`:"n/a",i=(()=>{if(e.connected||!e.lastError)return null;const a=e.lastError.toLowerCase();if(!(a.includes("unauthorized")||a.includes("connect failed")))return null;const r=!!e.settings.token.trim(),p=!!e.password.trim();return!r&&!p?d`
        <div class="muted" style="margin-top: 8px;">
          This gateway requires auth. Add a token or password, then click Connect.
          <div style="margin-top: 6px;">
            <span class="mono">clawdbot dashboard --no-open</span> → tokenized URL<br />
            <span class="mono">clawdbot doctor --generate-gateway-token</span> → set token
          </div>
          <div style="margin-top: 6px;">
            <a
              class="session-link"
              href="https://docs.clawd.bot/web/dashboard"
              target="_blank"
              rel="noreferrer"
              title="Control UI auth docs (opens in new tab)"
              >Docs: Control UI auth</a
            >
          </div>
        </div>
      `:d`
      <div class="muted" style="margin-top: 8px;">
        Auth failed. Re-copy a tokenized URL with
        <span class="mono">clawdbot dashboard --no-open</span>, or update the token,
        then click Connect.
        <div style="margin-top: 6px;">
          <a
            class="session-link"
            href="https://docs.clawd.bot/web/dashboard"
            target="_blank"
            rel="noreferrer"
            title="Control UI auth docs (opens in new tab)"
            >Docs: Control UI auth</a
          >
        </div>
      </div>
    `})(),o=(()=>{if(e.connected||!e.lastError||(typeof window<"u"?window.isSecureContext:!0)!==!1)return null;const c=e.lastError.toLowerCase();return!c.includes("secure context")&&!c.includes("device identity required")?null:d`
      <div class="muted" style="margin-top: 8px;">
        This page is HTTP, so the browser blocks device identity. Use HTTPS (Tailscale Serve) or
        open <span class="mono">http://127.0.0.1:18789</span> on the gateway host.
        <div style="margin-top: 6px;">
          If you must stay on HTTP, set
          <span class="mono">gateway.controlUi.allowInsecureAuth: true</span> (token-only).
        </div>
        <div style="margin-top: 6px;">
          <a
            class="session-link"
            href="https://docs.clawd.bot/gateway/tailscale"
            target="_blank"
            rel="noreferrer"
            title="Tailscale Serve docs (opens in new tab)"
            >Docs: Tailscale Serve</a
          >
          <span class="muted"> · </span>
          <a
            class="session-link"
            href="https://docs.clawd.bot/web/control-ui#insecure-http"
            target="_blank"
            rel="noreferrer"
            title="Insecure HTTP docs (opens in new tab)"
            >Docs: Insecure HTTP</a
          >
        </div>
      </div>
    `})();return d`
    <section class="grid grid-cols-2">
      <div class="card">
        <div class="card-title">Gateway Access</div>
        <div class="card-sub">Where the dashboard connects and how it authenticates.</div>
        <div class="form-grid" style="margin-top: 16px;">
          <label class="field">
            <span>WebSocket URL</span>
            <input
              .value=${e.settings.gatewayUrl}
              @input=${a=>{const c=a.target.value;e.onSettingsChange({...e.settings,gatewayUrl:c})}}
              placeholder="ws://100.x.y.z:18789"
            />
          </label>
          <label class="field">
            <span>Gateway Token</span>
            <input
              .value=${e.settings.token}
              @input=${a=>{const c=a.target.value;e.onSettingsChange({...e.settings,token:c})}}
              placeholder="CLAWDBOT_GATEWAY_TOKEN"
            />
          </label>
          <label class="field">
            <span>Password (not stored)</span>
            <input
              type="password"
              .value=${e.password}
              @input=${a=>{const c=a.target.value;e.onPasswordChange(c)}}
              placeholder="system or shared password"
            />
          </label>
          <label class="field">
            <span>Default Session Key</span>
            <input
              .value=${e.settings.sessionKey}
              @input=${a=>{const c=a.target.value;e.onSessionKeyChange(c)}}
            />
          </label>
        </div>
        <div class="row" style="margin-top: 14px;">
          <button class="btn" @click=${()=>e.onConnect()}>Connect</button>
          <button class="btn" @click=${()=>e.onRefresh()}>Refresh</button>
          <span class="muted">Click Connect to apply connection changes.</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Snapshot</div>
        <div class="card-sub">Latest gateway handshake information.</div>
        <div class="stat-grid" style="margin-top: 16px;">
          <div class="stat">
            <div class="stat-label">Status</div>
            <div class="stat-value ${e.connected?"ok":"warn"}">
              ${e.connected?"Connected":"Disconnected"}
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">Uptime</div>
            <div class="stat-value">${n}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Tick Interval</div>
            <div class="stat-value">${s}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Last Channels Refresh</div>
            <div class="stat-value">
              ${e.lastChannelsRefresh?O(e.lastChannelsRefresh):"n/a"}
            </div>
          </div>
        </div>
        ${e.lastError?d`<div class="callout danger" style="margin-top: 14px;">
              <div>${e.lastError}</div>
              ${i??""}
              ${o??""}
            </div>`:d`<div class="callout" style="margin-top: 14px;">
              Use Channels to link WhatsApp, Telegram, Discord, Signal, or iMessage.
            </div>`}
      </div>
    </section>

    <section class="grid grid-cols-3" style="margin-top: 18px;">
      <div class="card stat-card">
        <div class="stat-label">Instances</div>
        <div class="stat-value">${e.presenceCount}</div>
        <div class="muted">Presence beacons in the last 5 minutes.</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Sessions</div>
        <div class="stat-value">${e.sessionsCount??"n/a"}</div>
        <div class="muted">Recent session keys tracked by the gateway.</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Cron</div>
        <div class="stat-value">
          ${e.cronEnabled==null?"n/a":e.cronEnabled?"Enabled":"Disabled"}
        </div>
        <div class="muted">Next wake ${dr(e.cronNext)}</div>
      </div>
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">Notes</div>
      <div class="card-sub">Quick reminders for remote control setups.</div>
      <div class="note-grid" style="margin-top: 14px;">
        <div>
          <div class="note-title">Tailscale serve</div>
          <div class="muted">
            Prefer serve mode to keep the gateway on loopback with tailnet auth.
          </div>
        </div>
        <div>
          <div class="note-title">Session hygiene</div>
          <div class="muted">Use /new or sessions.patch to reset context.</div>
        </div>
        <div>
          <div class="note-title">Cron reminders</div>
          <div class="muted">Use isolated sessions for recurring runs.</div>
        </div>
      </div>
    </section>
  `}const Jf=["","off","minimal","low","medium","high"],Zf=["","off","on"],Xf=[{value:"",label:"inherit"},{value:"off",label:"off (explicit)"},{value:"on",label:"on"}],eh=["","off","on","stream"];function th(e){if(!e)return"";const t=e.trim().toLowerCase();return t==="z.ai"||t==="z-ai"?"zai":t}function ur(e){return th(e)==="zai"}function nh(e){return ur(e)?Zf:Jf}function sh(e,t){return!t||!e||e==="off"?e:"on"}function ih(e,t){return e?t&&e==="on"?"low":e:null}function oh(e){const t=e.result?.sessions??[];return d`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Sessions</div>
          <div class="card-sub">Active session keys and per-session overrides.</div>
        </div>
        <button class="btn" ?disabled=${e.loading} @click=${e.onRefresh}>
          ${e.loading?"Loading…":"Refresh"}
        </button>
      </div>

      <div class="filters" style="margin-top: 14px;">
        <label class="field">
          <span>Active within (minutes)</span>
          <input
            .value=${e.activeMinutes}
            @input=${n=>e.onFiltersChange({activeMinutes:n.target.value,limit:e.limit,includeGlobal:e.includeGlobal,includeUnknown:e.includeUnknown})}
          />
        </label>
        <label class="field">
          <span>Limit</span>
          <input
            .value=${e.limit}
            @input=${n=>e.onFiltersChange({activeMinutes:e.activeMinutes,limit:n.target.value,includeGlobal:e.includeGlobal,includeUnknown:e.includeUnknown})}
          />
        </label>
        <label class="field checkbox">
          <span>Include global</span>
          <input
            type="checkbox"
            .checked=${e.includeGlobal}
            @change=${n=>e.onFiltersChange({activeMinutes:e.activeMinutes,limit:e.limit,includeGlobal:n.target.checked,includeUnknown:e.includeUnknown})}
          />
        </label>
        <label class="field checkbox">
          <span>Include unknown</span>
          <input
            type="checkbox"
            .checked=${e.includeUnknown}
            @change=${n=>e.onFiltersChange({activeMinutes:e.activeMinutes,limit:e.limit,includeGlobal:e.includeGlobal,includeUnknown:n.target.checked})}
          />
        </label>
      </div>

      ${e.error?d`<div class="callout danger" style="margin-top: 12px;">${e.error}</div>`:g}

      <div class="muted" style="margin-top: 12px;">
        ${e.result?`Store: ${e.result.path}`:""}
      </div>

      <div class="table" style="margin-top: 16px;">
        <div class="table-head">
          <div>Key</div>
          <div>Label</div>
          <div>Kind</div>
          <div>Updated</div>
          <div>Tokens</div>
          <div>Thinking</div>
          <div>Verbose</div>
          <div>Reasoning</div>
          <div>Actions</div>
        </div>
        ${t.length===0?d`<div class="muted">No sessions found.</div>`:t.map(n=>ah(n,e.basePath,e.onPatch,e.onDelete,e.loading))}
      </div>
    </section>
  `}function ah(e,t,n,s,i){const o=e.updatedAt?O(e.updatedAt):"n/a",a=e.thinkingLevel??"",c=ur(e.modelProvider),r=sh(a,c),p=nh(e.modelProvider),l=e.verboseLevel??"",u=e.reasoningLevel??"",h=e.displayName??e.key,v=e.kind!=="global",w=v?`${Is("chat",t)}?session=${encodeURIComponent(e.key)}`:null;return d`
    <div class="table-row">
      <div class="mono">${v?d`<a href=${w} class="session-link">${h}</a>`:h}</div>
      <div>
        <input
          .value=${e.label??""}
          ?disabled=${i}
          placeholder="(optional)"
          @change=${$=>{const x=$.target.value.trim();n(e.key,{label:x||null})}}
        />
      </div>
      <div>${e.kind}</div>
      <div>${o}</div>
      <div>${lf(e)}</div>
      <div>
        <select
          .value=${r}
          ?disabled=${i}
          @change=${$=>{const x=$.target.value;n(e.key,{thinkingLevel:ih(x,c)})}}
        >
          ${p.map($=>d`<option value=${$}>${$||"inherit"}</option>`)}
        </select>
      </div>
      <div>
        <select
          .value=${l}
          ?disabled=${i}
          @change=${$=>{const x=$.target.value;n(e.key,{verboseLevel:x||null})}}
        >
          ${Xf.map($=>d`<option value=${$.value}>${$.label}</option>`)}
        </select>
      </div>
      <div>
        <select
          .value=${u}
          ?disabled=${i}
          @change=${$=>{const x=$.target.value;n(e.key,{reasoningLevel:x||null})}}
        >
          ${eh.map($=>d`<option value=${$}>${$||"inherit"}</option>`)}
        </select>
      </div>
      <div>
        <button class="btn danger" ?disabled=${i} @click=${()=>s(e.key)}>
          Delete
        </button>
      </div>
    </div>
  `}function rh(e){const t=Math.max(0,e),n=Math.floor(t/1e3);if(n<60)return`${n}s`;const s=Math.floor(n/60);return s<60?`${s}m`:`${Math.floor(s/60)}h`}function Le(e,t){return t?d`<div class="exec-approval-meta-row"><span>${e}</span><span>${t}</span></div>`:g}function lh(e){const t=e.execApprovalQueue[0];if(!t)return g;const n=t.request,s=t.expiresAtMs-Date.now(),i=s>0?`expires in ${rh(s)}`:"expired",o=e.execApprovalQueue.length;return d`
    <div class="exec-approval-overlay" role="dialog" aria-live="polite">
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">Exec approval needed</div>
            <div class="exec-approval-sub">${i}</div>
          </div>
          ${o>1?d`<div class="exec-approval-queue">${o} pending</div>`:g}
        </div>
        <div class="exec-approval-command mono">${n.command}</div>
        <div class="exec-approval-meta">
          ${Le("Host",n.host)}
          ${Le("Agent",n.agentId)}
          ${Le("Session",n.sessionKey)}
          ${Le("CWD",n.cwd)}
          ${Le("Resolved",n.resolvedPath)}
          ${Le("Security",n.security)}
          ${Le("Ask",n.ask)}
        </div>
        ${e.execApprovalError?d`<div class="exec-approval-error">${e.execApprovalError}</div>`:g}
        <div class="exec-approval-actions">
          <button
            class="btn primary"
            ?disabled=${e.execApprovalBusy}
            @click=${()=>e.handleExecApprovalDecision("allow-once")}
          >
            Allow once
          </button>
          <button
            class="btn"
            ?disabled=${e.execApprovalBusy}
            @click=${()=>e.handleExecApprovalDecision("allow-always")}
          >
            Always allow
          </button>
          <button
            class="btn danger"
            ?disabled=${e.execApprovalBusy}
            @click=${()=>e.handleExecApprovalDecision("deny")}
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  `}function ch(e){const t=e.report?.skills??[],n=e.filter.trim().toLowerCase(),s=n?t.filter(i=>[i.name,i.description,i.source].join(" ").toLowerCase().includes(n)):t;return d`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Skills</div>
          <div class="card-sub">Bundled, managed, and workspace skills.</div>
        </div>
        <button class="btn" ?disabled=${e.loading} @click=${e.onRefresh}>
          ${e.loading?"Loading…":"Refresh"}
        </button>
      </div>

      <div class="filters" style="margin-top: 14px;">
        <label class="field" style="flex: 1;">
          <span>Filter</span>
          <input
            .value=${e.filter}
            @input=${i=>e.onFilterChange(i.target.value)}
            placeholder="Search skills"
          />
        </label>
        <div class="muted">${s.length} shown</div>
      </div>

      ${e.error?d`<div class="callout danger" style="margin-top: 12px;">${e.error}</div>`:g}

      ${s.length===0?d`<div class="muted" style="margin-top: 16px;">No skills found.</div>`:d`
            <div class="list" style="margin-top: 16px;">
              ${s.map(i=>dh(i,e))}
            </div>
          `}
    </section>
  `}function dh(e,t){const n=t.busyKey===e.skillKey,s=t.edits[e.skillKey]??"",i=t.messages[e.skillKey]??null,o=e.install.length>0&&e.missing.bins.length>0,a=[...e.missing.bins.map(r=>`bin:${r}`),...e.missing.env.map(r=>`env:${r}`),...e.missing.config.map(r=>`config:${r}`),...e.missing.os.map(r=>`os:${r}`)],c=[];return e.disabled&&c.push("disabled"),e.blockedByAllowlist&&c.push("blocked by allowlist"),d`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">
          ${e.emoji?`${e.emoji} `:""}${e.name}
        </div>
        <div class="list-sub">${ss(e.description,140)}</div>
        <div class="chip-row" style="margin-top: 6px;">
          <span class="chip">${e.source}</span>
          <span class="chip ${e.eligible?"chip-ok":"chip-warn"}">
            ${e.eligible?"eligible":"blocked"}
          </span>
          ${e.disabled?d`<span class="chip chip-warn">disabled</span>`:g}
        </div>
        ${a.length>0?d`
              <div class="muted" style="margin-top: 6px;">
                Missing: ${a.join(", ")}
              </div>
            `:g}
        ${c.length>0?d`
              <div class="muted" style="margin-top: 6px;">
                Reason: ${c.join(", ")}
              </div>
            `:g}
      </div>
      <div class="list-meta">
        <div class="row" style="justify-content: flex-end; flex-wrap: wrap;">
          <button
            class="btn"
            ?disabled=${n}
            @click=${()=>t.onToggle(e.skillKey,e.disabled)}
          >
            ${e.disabled?"Enable":"Disable"}
          </button>
          ${o?d`<button
                class="btn"
                ?disabled=${n}
                @click=${()=>t.onInstall(e.skillKey,e.name,e.install[0].id)}
              >
                ${n?"Installing…":e.install[0].label}
              </button>`:g}
        </div>
        ${i?d`<div
              class="muted"
              style="margin-top: 8px; color: ${i.kind==="error"?"var(--danger-color, #d14343)":"var(--success-color, #0a7f5a)"};"
            >
              ${i.message}
            </div>`:g}
        ${e.primaryEnv?d`
              <div class="field" style="margin-top: 10px;">
                <span>API key</span>
                <input
                  type="password"
                  .value=${s}
                  @input=${r=>t.onEdit(e.skillKey,r.target.value)}
                />
              </div>
              <button
                class="btn primary"
                style="margin-top: 8px;"
                ?disabled=${n}
                @click=${()=>t.onSaveKey(e.skillKey)}
              >
                Save key
              </button>
            `:g}
      </div>
    </div>
  `}function uh(e,t){const n=Is(t,e.basePath);return d`
    <a
      href=${n}
      class="nav-item ${e.tab===t?"active":""}"
      @click=${s=>{s.defaultPrevented||s.button!==0||s.metaKey||s.ctrlKey||s.shiftKey||s.altKey||(s.preventDefault(),e.setTab(t))}}
      title=${ts(t)}
    >
      <span class="nav-item__icon" aria-hidden="true">${ul(t)}</span>
      <span class="nav-item__text">${ts(t)}</span>
    </a>
  `}function ph(e){const t=fh(e.sessionKey,e.sessionsResult),n=e.onboarding,s=e.onboarding,i=e.onboarding?!1:e.settings.chatShowThinking,o=e.onboarding?!0:e.settings.chatFocusMode,a=d`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path></svg>`,c=d`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h3"></path><path d="M20 7V4h-3"></path><path d="M4 17v3h3"></path><path d="M20 17v3h-3"></path><circle cx="12" cy="12" r="3"></circle></svg>`;return d`
    <div class="chat-controls">
      <label class="field chat-controls__session">
        <select
          .value=${e.sessionKey}
          ?disabled=${!e.connected}
          @change=${r=>{const p=r.target.value;e.sessionKey=p,e.chatMessage="",e.chatStream=null,e.chatStreamStartedAt=null,e.chatRunId=null,e.resetToolStream(),e.resetChatScroll(),e.applySettings({...e.settings,sessionKey:p,lastActiveSessionKey:p}),e.loadAssistantIdentity(),id(e,p),Je(e)}}
        >
          ${Da(t,r=>r.key,r=>d`<option value=${r.key}>
                ${r.displayName??r.key}
              </option>`)}
        </select>
      </label>
      <button
        class="btn btn--sm btn--icon"
        ?disabled=${e.chatLoading||!e.connected}
        @click=${()=>{e.resetToolStream(),Je(e)}}
        title="Refresh chat history"
      >
        ${a}
      </button>
      <span class="chat-controls__separator">|</span>
      <button
        class="btn btn--sm btn--icon ${i?"active":""}"
        ?disabled=${n}
        @click=${()=>{n||e.applySettings({...e.settings,chatShowThinking:!e.settings.chatShowThinking})}}
        aria-pressed=${i}
        title=${n?"Disabled during onboarding":"Toggle assistant thinking/working output"}
      >
        🧠
      </button>
      <button
        class="btn btn--sm btn--icon ${o?"active":""}"
        ?disabled=${s}
        @click=${()=>{s||e.applySettings({...e.settings,chatFocusMode:!e.settings.chatFocusMode})}}
        aria-pressed=${o}
        title=${s?"Disabled during onboarding":"Toggle focus mode (hide sidebar + page header)"}
      >
        ${c}
      </button>
    </div>
  `}function fh(e,t){const n=new Set,s=[],i=t?.sessions?.find(o=>o.key===e);if(n.add(e),s.push({key:e,displayName:i?.displayName}),t?.sessions)for(const o of t.sessions)n.has(o.key)||(n.add(o.key),s.push({key:o.key,displayName:o.displayName}));return s}const hh=["system","light","dark"];function gh(e){const t=Math.max(0,hh.indexOf(e.theme)),n=s=>i=>{const a={element:i.currentTarget};(i.clientX||i.clientY)&&(a.pointerClientX=i.clientX,a.pointerClientY=i.clientY),e.setTheme(s,a)};return d`
    <div class="theme-toggle" style="--theme-index: ${t};">
      <div class="theme-toggle__track" role="group" aria-label="Theme">
        <span class="theme-toggle__indicator"></span>
        <button
          class="theme-toggle__button ${e.theme==="system"?"active":""}"
          @click=${n("system")}
          aria-pressed=${e.theme==="system"}
          aria-label="System theme"
          title="System"
        >
          ${bh()}
        </button>
        <button
          class="theme-toggle__button ${e.theme==="light"?"active":""}"
          @click=${n("light")}
          aria-pressed=${e.theme==="light"}
          aria-label="Light theme"
          title="Light"
        >
          ${vh()}
        </button>
        <button
          class="theme-toggle__button ${e.theme==="dark"?"active":""}"
          @click=${n("dark")}
          aria-pressed=${e.theme==="dark"}
          aria-label="Dark theme"
          title="Dark"
        >
          ${mh()}
        </button>
      </div>
    </div>
  `}function vh(){return d`
    <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4"></circle>
      <path d="M12 2v2"></path>
      <path d="M12 20v2"></path>
      <path d="m4.93 4.93 1.41 1.41"></path>
      <path d="m17.66 17.66 1.41 1.41"></path>
      <path d="M2 12h2"></path>
      <path d="M20 12h2"></path>
      <path d="m6.34 17.66-1.41 1.41"></path>
      <path d="m19.07 4.93-1.41 1.41"></path>
    </svg>
  `}function mh(){return d`
    <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"
      ></path>
    </svg>
  `}function bh(){return d`
    <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect width="20" height="14" x="2" y="3" rx="2"></rect>
      <line x1="8" x2="16" y1="21" y2="21"></line>
      <line x1="12" x2="12" y1="17" y2="21"></line>
    </svg>
  `}const yh=/^data:/i,wh=/^https?:\/\//i;function $h(e){const t=e.agentsList?.agents??[],s=Jo(e.sessionKey)?.agentId??e.agentsList?.defaultId??"main",o=t.find(c=>c.id===s)?.identity,a=o?.avatarUrl??o?.avatar;if(a)return yh.test(a)||wh.test(a)?a:o?.avatarUrl}function kh(e){const t=e.presenceEntries.length,n=e.sessionsResult?.count??null,s=e.cronStatus?.nextWakeAtMs??null,i=e.connected?null:"Disconnected from gateway.",o=e.tab==="chat",a=o&&(e.settings.chatFocusMode||e.onboarding),c=e.onboarding?!1:e.settings.chatShowThinking,r=$h(e),p=e.chatAvatarUrl??r??null;return d`
    <div class="shell ${o?"shell--chat":""} ${a?"shell--chat-focus":""} ${e.settings.navCollapsed?"shell--nav-collapsed":""} ${e.onboarding?"shell--onboarding":""}">
      <header class="topbar">
        <div class="topbar-left">
          <button
            class="nav-collapse-toggle"
            @click=${()=>e.applySettings({...e.settings,navCollapsed:!e.settings.navCollapsed})}
            title="${e.settings.navCollapsed?"Expand sidebar":"Collapse sidebar"}"
            aria-label="${e.settings.navCollapsed?"Expand sidebar":"Collapse sidebar"}"
          >
            <span class="nav-collapse-toggle__icon">☰</span>
          </button>
          <div class="brand">
            <div class="brand-title">CLAWDBOT</div>
            <div class="brand-sub">Gateway Dashboard</div>
          </div>
        </div>
        <div class="topbar-status">
          <div class="pill">
            <span class="statusDot ${e.connected?"ok":""}"></span>
            <span>Health</span>
            <span class="mono">${e.connected?"OK":"Offline"}</span>
          </div>
          ${gh(e)}
        </div>
      </header>
      <aside class="nav ${e.settings.navCollapsed?"nav--collapsed":""}">
        ${cl.map(l=>{const u=e.settings.navGroupsCollapsed[l.label]??!1,h=l.tabs.some(v=>v===e.tab);return d`
            <div class="nav-group ${u&&!h?"nav-group--collapsed":""}">
              <button
                class="nav-label"
                @click=${()=>{const v={...e.settings.navGroupsCollapsed};v[l.label]=!u,e.applySettings({...e.settings,navGroupsCollapsed:v})}}
                aria-expanded=${!u}
              >
                <span class="nav-label__text">${l.label}</span>
                <span class="nav-label__chevron">${u?"+":"−"}</span>
              </button>
              <div class="nav-group__items">
                ${l.tabs.map(v=>uh(e,v))}
              </div>
            </div>
          `})}
        <div class="nav-group nav-group--links">
          <div class="nav-label nav-label--static">
            <span class="nav-label__text">Resources</span>
          </div>
          <div class="nav-group__items">
            <a
              class="nav-item nav-item--external"
              href="https://docs.clawd.bot"
              target="_blank"
              rel="noreferrer"
              title="Docs (opens in new tab)"
            >
              <span class="nav-item__icon" aria-hidden="true">📚</span>
              <span class="nav-item__text">Docs</span>
            </a>
          </div>
        </div>
      </aside>
      <main class="content ${o?"content--chat":""}">
        <section class="content-header">
          <div>
            <div class="page-title">${ts(e.tab)}</div>
            <div class="page-sub">${pl(e.tab)}</div>
          </div>
          <div class="page-meta">
            ${e.lastError?d`<div class="pill danger">${e.lastError}</div>`:g}
            ${o?ph(e):g}
          </div>
        </section>

        ${e.tab==="overview"?Qf({connected:e.connected,hello:e.hello,settings:e.settings,password:e.password,lastError:e.lastError,presenceCount:t,sessionsCount:n,cronEnabled:e.cronStatus?.enabled??null,cronNext:s,lastChannelsRefresh:e.channelsLastSuccess,onSettingsChange:l=>e.applySettings(l),onPasswordChange:l=>e.password=l,onSessionKeyChange:l=>{e.sessionKey=l,e.chatMessage="",e.resetToolStream(),e.applySettings({...e.settings,sessionKey:l,lastActiveSessionKey:l}),e.loadAssistantIdentity()},onConnect:()=>e.connect(),onRefresh:()=>e.loadOverview()}):g}

        ${e.tab==="channels"?Yp({connected:e.connected,loading:e.channelsLoading,snapshot:e.channelsSnapshot,lastError:e.channelsError,lastSuccessAt:e.channelsLastSuccess,whatsappMessage:e.whatsappLoginMessage,whatsappQrDataUrl:e.whatsappLoginQrDataUrl,whatsappConnected:e.whatsappLoginConnected,whatsappBusy:e.whatsappBusy,configSchema:e.configSchema,configSchemaLoading:e.configSchemaLoading,configForm:e.configForm,configUiHints:e.configUiHints,configSaving:e.configSaving,configFormDirty:e.configFormDirty,nostrProfileFormState:e.nostrProfileFormState,nostrProfileAccountId:e.nostrProfileAccountId,onRefresh:l=>oe(e,l),onWhatsAppStart:l=>e.handleWhatsAppStart(l),onWhatsAppWait:()=>e.handleWhatsAppWait(),onWhatsAppLogout:()=>e.handleWhatsAppLogout(),onConfigPatch:(l,u)=>Nt(e,l,u),onConfigSave:()=>e.handleChannelConfigSave(),onConfigReload:()=>e.handleChannelConfigReload(),onNostrProfileEdit:(l,u)=>e.handleNostrProfileEdit(l,u),onNostrProfileCancel:()=>e.handleNostrProfileCancel(),onNostrProfileFieldChange:(l,u)=>e.handleNostrProfileFieldChange(l,u),onNostrProfileSave:()=>e.handleNostrProfileSave(),onNostrProfileImport:()=>e.handleNostrProfileImport(),onNostrProfileToggleAdvanced:()=>e.handleNostrProfileToggleAdvanced()}):g}

        ${e.tab==="instances"?wf({loading:e.presenceLoading,entries:e.presenceEntries,lastError:e.presenceError,statusMessage:e.presenceStatus,onRefresh:()=>Ks(e)}):g}

        ${e.tab==="sessions"?oh({loading:e.sessionsLoading,result:e.sessionsResult,error:e.sessionsError,activeMinutes:e.sessionsFilterActive,limit:e.sessionsFilterLimit,includeGlobal:e.sessionsIncludeGlobal,includeUnknown:e.sessionsIncludeUnknown,basePath:e.basePath,onFiltersChange:l=>{e.sessionsFilterActive=l.activeMinutes,e.sessionsFilterLimit=l.limit,e.sessionsIncludeGlobal=l.includeGlobal,e.sessionsIncludeUnknown=l.includeUnknown},onRefresh:()=>tt(e),onPatch:(l,u)=>xl(e,l,u),onDelete:l=>Al(e,l)}):g}

        ${e.tab==="cron"?gf({loading:e.cronLoading,status:e.cronStatus,jobs:e.cronJobs,error:e.cronError,busy:e.cronBusy,form:e.cronForm,channels:e.channelsSnapshot?.channelMeta?.length?e.channelsSnapshot.channelMeta.map(l=>l.id):e.channelsSnapshot?.channelOrder??[],channelLabels:e.channelsSnapshot?.channelLabels??{},channelMeta:e.channelsSnapshot?.channelMeta??[],runsJobId:e.cronRunsJobId,runs:e.cronRuns,onFormChange:l=>e.cronForm={...e.cronForm,...l},onRefresh:()=>e.loadCron(),onAdd:()=>jl(e),onToggle:(l,u)=>ql(e,l,u),onRun:l=>Wl(e,l),onRemove:l=>Vl(e,l),onLoadRuns:l=>ra(e,l)}):g}

        ${e.tab==="skills"?ch({loading:e.skillsLoading,report:e.skillsReport,error:e.skillsError,filter:e.skillsFilter,edits:e.skillEdits,messages:e.skillMessages,busyKey:e.skillsBusyKey,onFilterChange:l=>e.skillsFilter=l,onRefresh:()=>_t(e,{clearMessages:!0}),onToggle:(l,u)=>Kc(e,l,u),onEdit:(l,u)=>Uc(e,l,u),onSaveKey:l=>Hc(e,l),onInstall:(l,u,h)=>zc(e,l,u,h)}):g}

        ${e.tab==="nodes"?Sf({loading:e.nodesLoading,nodes:e.nodes,devicesLoading:e.devicesLoading,devicesError:e.devicesError,devicesList:e.devicesList,configForm:e.configForm??e.configSnapshot?.config,configLoading:e.configLoading,configSaving:e.configSaving,configDirty:e.configFormDirty,configFormMode:e.configFormMode,execApprovalsLoading:e.execApprovalsLoading,execApprovalsSaving:e.execApprovalsSaving,execApprovalsDirty:e.execApprovalsDirty,execApprovalsSnapshot:e.execApprovalsSnapshot,execApprovalsForm:e.execApprovalsForm,execApprovalsSelectedAgent:e.execApprovalsSelectedAgent,execApprovalsTarget:e.execApprovalsTarget,execApprovalsTargetNodeId:e.execApprovalsTargetNodeId,onRefresh:()=>un(e),onDevicesRefresh:()=>Se(e),onDeviceApprove:l=>Ic(e,l),onDeviceReject:l=>Lc(e,l),onDeviceRotate:(l,u,h)=>Rc(e,{deviceId:l,role:u,scopes:h}),onDeviceRevoke:(l,u)=>Mc(e,{deviceId:l,role:u}),onLoadConfig:()=>me(e),onLoadExecApprovals:()=>{const l=e.execApprovalsTarget==="node"&&e.execApprovalsTargetNodeId?{kind:"node",nodeId:e.execApprovalsTargetNodeId}:{kind:"gateway"};return Us(e,l)},onBindDefault:l=>{l?Nt(e,["tools","exec","node"],l):Gi(e,["tools","exec","node"])},onBindAgent:(l,u)=>{const h=["agents","list",l,"tools","exec","node"];u?Nt(e,h,u):Gi(e,h)},onSaveBindings:()=>os(e),onExecApprovalsTargetChange:(l,u)=>{e.execApprovalsTarget=l,e.execApprovalsTargetNodeId=u,e.execApprovalsSnapshot=null,e.execApprovalsForm=null,e.execApprovalsDirty=!1,e.execApprovalsSelectedAgent=null},onExecApprovalsSelectAgent:l=>{e.execApprovalsSelectedAgent=l},onExecApprovalsPatch:(l,u)=>Bc(e,l,u),onExecApprovalsRemove:l=>Fc(e,l),onSaveExecApprovals:()=>{const l=e.execApprovalsTarget==="node"&&e.execApprovalsTargetNodeId?{kind:"node",nodeId:e.execApprovalsTargetNodeId}:{kind:"gateway"};return Dc(e,l)}}):g}

        ${e.tab==="chat"?pp({sessionKey:e.sessionKey,onSessionKeyChange:l=>{e.sessionKey=l,e.chatMessage="",e.chatStream=null,e.chatStreamStartedAt=null,e.chatRunId=null,e.chatQueue=[],e.resetToolStream(),e.resetChatScroll(),e.applySettings({...e.settings,sessionKey:l,lastActiveSessionKey:l}),e.loadAssistantIdentity(),Je(e),ds(e)},thinkingLevel:e.chatThinkingLevel,showThinking:c,loading:e.chatLoading,sending:e.chatSending,assistantAvatarUrl:p,messages:e.chatMessages,toolMessages:e.chatToolMessages,stream:e.chatStream,streamStartedAt:e.chatStreamStartedAt,draft:e.chatMessage,queue:e.chatQueue,connected:e.connected,canSend:e.connected,disabledReason:i,error:e.lastError,sessions:e.sessionsResult,focusMode:a,onRefresh:()=>(e.resetToolStream(),Promise.all([Je(e),ds(e)])),onToggleFocusMode:()=>{e.onboarding||e.applySettings({...e.settings,chatFocusMode:!e.settings.chatFocusMode})},onChatScroll:l=>e.handleChatScroll(l),onDraftChange:l=>e.chatMessage=l,onSend:()=>e.handleSendChat(),canAbort:!!e.chatRunId,onAbort:()=>{e.handleAbortChat()},onQueueRemove:l=>e.removeQueuedMessage(l),onNewSession:()=>e.handleSendChat("/new",{restoreDraft:!0}),sidebarOpen:e.sidebarOpen,sidebarContent:e.sidebarContent,sidebarError:e.sidebarError,splitRatio:e.splitRatio,onOpenSidebar:l=>e.handleOpenSidebar(l),onCloseSidebar:()=>e.handleCloseSidebar(),onSplitRatioChange:l=>e.handleSplitRatioChange(l),assistantName:e.assistantName,assistantAvatar:e.assistantAvatar}):g}

        ${e.tab==="config"?Rp({raw:e.configRaw,valid:e.configValid,issues:e.configIssues,loading:e.configLoading,saving:e.configSaving,applying:e.configApplying,updating:e.updateRunning,connected:e.connected,schema:e.configSchema,schemaLoading:e.configSchemaLoading,uiHints:e.configUiHints,formMode:e.configFormMode,formValue:e.configForm,originalValue:e.configFormOriginal,searchQuery:e.configSearchQuery,activeSection:e.configActiveSection,activeSubsection:e.configActiveSubsection,onRawChange:l=>e.configRaw=l,onFormModeChange:l=>e.configFormMode=l,onFormPatch:(l,u)=>Nt(e,l,u),onSearchChange:l=>e.configSearchQuery=l,onSectionChange:l=>{e.configActiveSection=l,e.configActiveSubsection=null},onSubsectionChange:l=>e.configActiveSubsection=l,onReload:()=>me(e),onSave:()=>os(e),onApply:()=>Ul(e),onUpdate:()=>Kl(e)}):g}

        ${e.tab==="debug"?yf({loading:e.debugLoading,status:e.debugStatus,health:e.debugHealth,models:e.debugModels,heartbeat:e.debugHeartbeat,eventLog:e.eventLog,callMethod:e.debugCallMethod,callParams:e.debugCallParams,callResult:e.debugCallResult,callError:e.debugCallError,onCallMethodChange:l=>e.debugCallMethod=l,onCallParamsChange:l=>e.debugCallParams=l,onRefresh:()=>cn(e),onCall:()=>Jl(e)}):g}

        ${e.tab==="logs"?Af({loading:e.logsLoading,error:e.logsError,file:e.logsFile,entries:e.logsEntries,filterText:e.logsFilterText,levelFilters:e.logsLevelFilters,autoFollow:e.logsAutoFollow,truncated:e.logsTruncated,onFilterTextChange:l=>e.logsFilterText=l,onLevelToggle:(l,u)=>{e.logsLevelFilters={...e.logsLevelFilters,[l]:u}},onToggleAutoFollow:l=>e.logsAutoFollow=l,onRefresh:()=>Ms(e,{reset:!0}),onExport:(l,u)=>e.exportLogs(l,u),onScroll:l=>e.handleLogsScroll(l)}):g}
      </main>
      ${lh(e)}
    </div>
  `}const xh={trace:!0,debug:!0,info:!0,warn:!0,error:!0,fatal:!0},Ah={name:"",description:"",agentId:"",enabled:!0,scheduleKind:"every",scheduleAt:"",everyAmount:"30",everyUnit:"minutes",cronExpr:"0 7 * * *",cronTz:"",sessionTarget:"main",wakeMode:"next-heartbeat",payloadKind:"systemEvent",payloadText:"",deliver:!1,channel:"last",to:"",timeoutSeconds:"",postToMainPrefix:""};async function Sh(e){if(!(!e.client||!e.connected)&&!e.agentsLoading){e.agentsLoading=!0,e.agentsError=null;try{const t=await e.client.request("agents.list",{});t&&(e.agentsList=t)}catch(t){e.agentsError=String(t)}finally{e.agentsLoading=!1}}}const pr={WEBCHAT_UI:"webchat-ui",CONTROL_UI:"clawdbot-control-ui",WEBCHAT:"webchat",CLI:"cli",GATEWAY_CLIENT:"gateway-client",MACOS_APP:"clawdbot-macos",IOS_APP:"clawdbot-ios",ANDROID_APP:"clawdbot-android",NODE_HOST:"node-host",TEST:"test",FINGERPRINT:"fingerprint",PROBE:"clawdbot-probe"},Uo=pr,ks={WEBCHAT:"webchat",CLI:"cli",UI:"ui",BACKEND:"backend",NODE:"node",PROBE:"probe",TEST:"test"};new Set(Object.values(pr));new Set(Object.values(ks));function _h(e){const t=e.version??(e.nonce?"v2":"v1"),n=e.scopes.join(","),s=e.token??"",i=[t,e.deviceId,e.clientId,e.clientMode,e.role,n,String(e.signedAtMs),s];return t==="v2"&&i.push(e.nonce??""),i.join("|")}const Th=4008;class Eh{constructor(t){this.opts=t,this.ws=null,this.pending=new Map,this.closed=!1,this.lastSeq=null,this.connectNonce=null,this.connectSent=!1,this.connectTimer=null,this.backoffMs=800}start(){this.closed=!1,this.connect()}stop(){this.closed=!0,this.ws?.close(),this.ws=null,this.flushPending(new Error("gateway client stopped"))}get connected(){return this.ws?.readyState===WebSocket.OPEN}connect(){this.closed||(this.ws=new WebSocket(this.opts.url),this.ws.onopen=()=>this.queueConnect(),this.ws.onmessage=t=>this.handleMessage(String(t.data??"")),this.ws.onclose=t=>{const n=String(t.reason??"");this.ws=null,this.flushPending(new Error(`gateway closed (${t.code}): ${n}`)),this.opts.onClose?.({code:t.code,reason:n}),this.scheduleReconnect()},this.ws.onerror=()=>{})}scheduleReconnect(){if(this.closed)return;const t=this.backoffMs;this.backoffMs=Math.min(this.backoffMs*1.7,15e3),window.setTimeout(()=>this.connect(),t)}flushPending(t){for(const[,n]of this.pending)n.reject(t);this.pending.clear()}async sendConnect(){if(this.connectSent)return;this.connectSent=!0,this.connectTimer!==null&&(window.clearTimeout(this.connectTimer),this.connectTimer=null);const t=typeof crypto<"u"&&!!crypto.subtle,n=["operator.admin","operator.approvals","operator.pairing"],s="operator";let i=null,o=!1,a=this.opts.token;if(t){i=await Ds();const l=Cc({deviceId:i.deviceId,role:s})?.token;a=l??this.opts.token,o=!!(l&&this.opts.token)}const c=a||this.opts.password?{token:a,password:this.opts.password}:void 0;let r;if(t&&i){const l=Date.now(),u=this.connectNonce??void 0,h=_h({deviceId:i.deviceId,clientId:this.opts.clientName??Uo.CONTROL_UI,clientMode:this.opts.mode??ks.WEBCHAT,role:s,scopes:n,signedAtMs:l,token:a??null,nonce:u}),v=await Tc(i.privateKey,h);r={id:i.deviceId,publicKey:i.publicKey,signature:v,signedAt:l,nonce:u}}const p={minProtocol:3,maxProtocol:3,client:{id:this.opts.clientName??Uo.CONTROL_UI,version:this.opts.clientVersion??"dev",platform:this.opts.platform??navigator.platform??"web",mode:this.opts.mode??ks.WEBCHAT,instanceId:this.opts.instanceId},role:s,scopes:n,device:r,caps:[],auth:c,userAgent:navigator.userAgent,locale:navigator.language};this.request("connect",p).then(l=>{l?.auth?.deviceToken&&i&&Aa({deviceId:i.deviceId,role:l.auth.role??s,token:l.auth.deviceToken,scopes:l.auth.scopes??[]}),this.backoffMs=800,this.opts.onHello?.(l)}).catch(()=>{o&&i&&Sa({deviceId:i.deviceId,role:s}),this.ws?.close(Th,"connect failed")})}handleMessage(t){let n;try{n=JSON.parse(t)}catch{return}const s=n;if(s.type==="event"){const i=n;if(i.event==="connect.challenge"){const a=i.payload,c=a&&typeof a.nonce=="string"?a.nonce:null;c&&(this.connectNonce=c,this.sendConnect());return}const o=typeof i.seq=="number"?i.seq:null;o!==null&&(this.lastSeq!==null&&o>this.lastSeq+1&&this.opts.onGap?.({expected:this.lastSeq+1,received:o}),this.lastSeq=o),this.opts.onEvent?.(i);return}if(s.type==="res"){const i=n,o=this.pending.get(i.id);if(!o)return;this.pending.delete(i.id),i.ok?o.resolve(i.payload):o.reject(new Error(i.error?.message??"request failed"));return}}request(t,n){if(!this.ws||this.ws.readyState!==WebSocket.OPEN)return Promise.reject(new Error("gateway not connected"));const s=Ls(),i={type:"req",id:s,method:t,params:n},o=new Promise((a,c)=>{this.pending.set(s,{resolve:r=>a(r),reject:c})});return this.ws.send(JSON.stringify(i)),o}queueConnect(){this.connectNonce=null,this.connectSent=!1,this.connectTimer!==null&&window.clearTimeout(this.connectTimer),this.connectTimer=window.setTimeout(()=>{this.sendConnect()},750)}}function xs(e){return typeof e=="object"&&e!==null}function Ch(e){if(!xs(e))return null;const t=typeof e.id=="string"?e.id.trim():"",n=e.request;if(!t||!xs(n))return null;const s=typeof n.command=="string"?n.command.trim():"";if(!s)return null;const i=typeof e.createdAtMs=="number"?e.createdAtMs:0,o=typeof e.expiresAtMs=="number"?e.expiresAtMs:0;return!i||!o?null:{id:t,request:{command:s,cwd:typeof n.cwd=="string"?n.cwd:null,host:typeof n.host=="string"?n.host:null,security:typeof n.security=="string"?n.security:null,ask:typeof n.ask=="string"?n.ask:null,agentId:typeof n.agentId=="string"?n.agentId:null,resolvedPath:typeof n.resolvedPath=="string"?n.resolvedPath:null,sessionKey:typeof n.sessionKey=="string"?n.sessionKey:null},createdAtMs:i,expiresAtMs:o}}function Ih(e){if(!xs(e))return null;const t=typeof e.id=="string"?e.id.trim():"";return t?{id:t,decision:typeof e.decision=="string"?e.decision:null,resolvedBy:typeof e.resolvedBy=="string"?e.resolvedBy:null,ts:typeof e.ts=="number"?e.ts:null}:null}function fr(e){const t=Date.now();return e.filter(n=>n.expiresAtMs>t)}function Lh(e,t){const n=fr(e).filter(s=>s.id!==t.id);return n.push(t),n}function Ko(e,t){return fr(e).filter(n=>n.id!==t)}async function hr(e,t){if(!e.client||!e.connected)return;const n=e.sessionKey.trim(),s=n?{sessionKey:n}:{};try{const i=await e.client.request("agent.identity.get",s);if(!i)return;const o=es(i);e.assistantName=o.name,e.assistantAvatar=o.avatar,e.assistantAgentId=o.agentId??null}catch{}}function Jn(e,t){const n=(e??"").trim(),s=t.mainSessionKey?.trim();if(!s)return n;if(!n)return s;const i=t.mainKey?.trim()||"main",o=t.defaultAgentId?.trim();return n==="main"||n===i||o&&(n===`agent:${o}:main`||n===`agent:${o}:${i}`)?s:n}function Rh(e,t){if(!t?.mainSessionKey)return;const n=Jn(e.sessionKey,t),s=Jn(e.settings.sessionKey,t),i=Jn(e.settings.lastActiveSessionKey,t),o=n||s||e.sessionKey,a={...e.settings,sessionKey:s||o,lastActiveSessionKey:i||o},c=a.sessionKey!==e.settings.sessionKey||a.lastActiveSessionKey!==e.settings.lastActiveSessionKey;o!==e.sessionKey&&(e.sessionKey=o),c&&$e(e,a)}function gr(e){e.lastError=null,e.hello=null,e.connected=!1,e.execApprovalQueue=[],e.execApprovalError=null,e.client?.stop(),e.client=new Eh({url:e.settings.gatewayUrl,token:e.settings.token.trim()?e.settings.token:void 0,password:e.password.trim()?e.password:void 0,clientName:"clawdbot-control-ui",mode:"webchat",onHello:t=>{e.connected=!0,e.hello=t,Ph(e,t),hr(e),Sh(e),un(e,{quiet:!0}),Se(e,{quiet:!0}),Vs(e)},onClose:({code:t,reason:n})=>{e.connected=!1,e.lastError=`disconnected (${t}): ${n||"no reason"}`},onEvent:t=>Mh(e,t),onGap:({expected:t,received:n})=>{e.lastError=`event gap detected (expected seq ${t}, got ${n}); refresh recommended`}}),e.client.start()}function Mh(e,t){if(e.eventLogBuffer=[{ts:Date.now(),event:t.event,payload:t.payload},...e.eventLogBuffer].slice(0,250),e.tab==="debug"&&(e.eventLog=e.eventLogBuffer),t.event==="agent"){if(e.onboarding)return;Rl(e,t.payload);return}if(t.event==="chat"){const n=t.payload;n?.sessionKey&&_a(e,n.sessionKey);const s=kl(e,n);(s==="final"||s==="error"||s==="aborted")&&(Rs(e),ud(e)),s==="final"&&Je(e);return}if(t.event==="presence"){const n=t.payload;n?.presence&&Array.isArray(n.presence)&&(e.presenceEntries=n.presence,e.presenceError=null,e.presenceStatus=null);return}if(t.event==="cron"&&e.tab==="cron"&&Gs(e),(t.event==="device.pair.requested"||t.event==="device.pair.resolved")&&Se(e,{quiet:!0}),t.event==="exec.approval.requested"){const n=Ch(t.payload);if(n){e.execApprovalQueue=Lh(e.execApprovalQueue,n),e.execApprovalError=null;const s=Math.max(0,n.expiresAtMs-Date.now()+500);window.setTimeout(()=>{e.execApprovalQueue=Ko(e.execApprovalQueue,n.id)},s)}return}if(t.event==="exec.approval.resolved"){const n=Ih(t.payload);n&&(e.execApprovalQueue=Ko(e.execApprovalQueue,n.id))}}function Ph(e,t){const n=t.snapshot;n?.presence&&Array.isArray(n.presence)&&(e.presenceEntries=n.presence),n?.health&&(e.debugHealth=n.health),n?.sessionDefaults&&Rh(e,n.sessionDefaults)}function Nh(e){e.basePath=Zc(),nd(e,!0),Xc(e),ed(e),window.addEventListener("popstate",e.popStateHandler),Yc(e),gr(e),Vc(e),e.tab==="logs"&&zs(e),e.tab==="debug"&&qs(e)}function Oh(e){Dl(e)}function Dh(e){window.removeEventListener("popstate",e.popStateHandler),Gc(e),js(e),Ws(e),td(e),e.topbarObserver?.disconnect(),e.topbarObserver=null}function Bh(e,t){if(e.tab==="chat"&&(t.has("chatMessages")||t.has("chatToolMessages")||t.has("chatStream")||t.has("chatLoading")||t.has("tab"))){const n=t.has("tab"),s=t.has("chatLoading")&&t.get("chatLoading")===!0&&e.chatLoading===!1;rn(e,n||s||!e.chatHasAutoScrolled)}e.tab==="logs"&&(t.has("logsEntries")||t.has("logsAutoFollow")||t.has("tab"))&&e.logsAutoFollow&&e.logsAtBottom&&sa(e,t.has("tab")||t.has("logsAutoFollow"))}async function Fh(e,t){await Gl(e,t),await oe(e,!0)}async function Uh(e){await Yl(e),await oe(e,!0)}async function Kh(e){await Ql(e),await oe(e,!0)}async function Hh(e){await os(e),await me(e),await oe(e,!0)}async function zh(e){await me(e),await oe(e,!0)}function jh(e){if(!Array.isArray(e))return{};const t={};for(const n of e){if(typeof n!="string")continue;const[s,...i]=n.split(":");if(!s||i.length===0)continue;const o=s.trim(),a=i.join(":").trim();o&&a&&(t[o]=a)}return t}function vr(e){return(e.channelsSnapshot?.channelAccounts?.nostr??[])[0]?.accountId??e.nostrProfileAccountId??"default"}function mr(e,t=""){return`/api/channels/nostr/${encodeURIComponent(e)}/profile${t}`}function qh(e,t,n){e.nostrProfileAccountId=t,e.nostrProfileFormState=zp(n??void 0)}function Wh(e){e.nostrProfileFormState=null,e.nostrProfileAccountId=null}function Vh(e,t,n){const s=e.nostrProfileFormState;s&&(e.nostrProfileFormState={...s,values:{...s.values,[t]:n},fieldErrors:{...s.fieldErrors,[t]:""}})}function Gh(e){const t=e.nostrProfileFormState;t&&(e.nostrProfileFormState={...t,showAdvanced:!t.showAdvanced})}async function Yh(e){const t=e.nostrProfileFormState;if(!t||t.saving)return;const n=vr(e);e.nostrProfileFormState={...t,saving:!0,error:null,success:null,fieldErrors:{}};try{const s=await fetch(mr(n),{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(t.values)}),i=await s.json().catch(()=>null);if(!s.ok||i?.ok===!1||!i){const o=i?.error??`Profile update failed (${s.status})`;e.nostrProfileFormState={...t,saving:!1,error:o,success:null,fieldErrors:jh(i?.details)};return}if(!i.persisted){e.nostrProfileFormState={...t,saving:!1,error:"Profile publish failed on all relays.",success:null};return}e.nostrProfileFormState={...t,saving:!1,error:null,success:"Profile published to relays.",fieldErrors:{},original:{...t.values}},await oe(e,!0)}catch(s){e.nostrProfileFormState={...t,saving:!1,error:`Profile update failed: ${String(s)}`,success:null}}}async function Qh(e){const t=e.nostrProfileFormState;if(!t||t.importing)return;const n=vr(e);e.nostrProfileFormState={...t,importing:!0,error:null,success:null};try{const s=await fetch(mr(n,"/import"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({autoMerge:!0})}),i=await s.json().catch(()=>null);if(!s.ok||i?.ok===!1||!i){const r=i?.error??`Profile import failed (${s.status})`;e.nostrProfileFormState={...t,importing:!1,error:r,success:null};return}const o=i.merged??i.imported??null,a=o?{...t.values,...o}:t.values,c=!!(a.banner||a.website||a.nip05||a.lud16);e.nostrProfileFormState={...t,importing:!1,values:a,error:null,success:i.saved?"Profile imported from relays. Review and publish.":"Profile imported. Review and publish.",showAdvanced:c},i.saved&&await oe(e,!0)}catch(s){e.nostrProfileFormState={...t,importing:!1,error:`Profile import failed: ${String(s)}`,success:null}}}var Jh=Object.defineProperty,Zh=Object.getOwnPropertyDescriptor,b=(e,t,n,s)=>{for(var i=s>1?void 0:s?Zh(t,n):t,o=e.length-1,a;o>=0;o--)(a=e[o])&&(i=(s?a(t,n,i):a(i))||i);return s&&i&&Jh(t,n,i),i};const Zn=al();function Xh(){if(!window.location.search)return!1;const t=new URLSearchParams(window.location.search).get("onboarding");if(!t)return!1;const n=t.trim().toLowerCase();return n==="1"||n==="true"||n==="yes"||n==="on"}let m=class extends Ye{constructor(){super(...arguments),this.settings=rl(),this.password="",this.tab="chat",this.onboarding=Xh(),this.connected=!1,this.theme=this.settings.theme??"system",this.themeResolved="dark",this.hello=null,this.lastError=null,this.eventLog=[],this.eventLogBuffer=[],this.toolStreamSyncTimer=null,this.sidebarCloseTimer=null,this.assistantName=Zn.name,this.assistantAvatar=Zn.avatar,this.assistantAgentId=Zn.agentId??null,this.sessionKey=this.settings.sessionKey,this.chatLoading=!1,this.chatSending=!1,this.chatMessage="",this.chatMessages=[],this.chatToolMessages=[],this.chatStream=null,this.chatStreamStartedAt=null,this.chatRunId=null,this.chatAvatarUrl=null,this.chatThinkingLevel=null,this.chatQueue=[],this.sidebarOpen=!1,this.sidebarContent=null,this.sidebarError=null,this.splitRatio=this.settings.splitRatio,this.nodesLoading=!1,this.nodes=[],this.devicesLoading=!1,this.devicesError=null,this.devicesList=null,this.execApprovalsLoading=!1,this.execApprovalsSaving=!1,this.execApprovalsDirty=!1,this.execApprovalsSnapshot=null,this.execApprovalsForm=null,this.execApprovalsSelectedAgent=null,this.execApprovalsTarget="gateway",this.execApprovalsTargetNodeId=null,this.execApprovalQueue=[],this.execApprovalBusy=!1,this.execApprovalError=null,this.configLoading=!1,this.configRaw=`{
}
`,this.configValid=null,this.configIssues=[],this.configSaving=!1,this.configApplying=!1,this.updateRunning=!1,this.applySessionKey=this.settings.lastActiveSessionKey,this.configSnapshot=null,this.configSchema=null,this.configSchemaVersion=null,this.configSchemaLoading=!1,this.configUiHints={},this.configForm=null,this.configFormOriginal=null,this.configFormDirty=!1,this.configFormMode="form",this.configSearchQuery="",this.configActiveSection=null,this.configActiveSubsection=null,this.channelsLoading=!1,this.channelsSnapshot=null,this.channelsError=null,this.channelsLastSuccess=null,this.whatsappLoginMessage=null,this.whatsappLoginQrDataUrl=null,this.whatsappLoginConnected=null,this.whatsappBusy=!1,this.nostrProfileFormState=null,this.nostrProfileAccountId=null,this.presenceLoading=!1,this.presenceEntries=[],this.presenceError=null,this.presenceStatus=null,this.agentsLoading=!1,this.agentsList=null,this.agentsError=null,this.sessionsLoading=!1,this.sessionsResult=null,this.sessionsError=null,this.sessionsFilterActive="",this.sessionsFilterLimit="120",this.sessionsIncludeGlobal=!0,this.sessionsIncludeUnknown=!1,this.cronLoading=!1,this.cronJobs=[],this.cronStatus=null,this.cronError=null,this.cronForm={...Ah},this.cronRunsJobId=null,this.cronRuns=[],this.cronBusy=!1,this.skillsLoading=!1,this.skillsReport=null,this.skillsError=null,this.skillsFilter="",this.skillEdits={},this.skillsBusyKey=null,this.skillMessages={},this.debugLoading=!1,this.debugStatus=null,this.debugHealth=null,this.debugModels=[],this.debugHeartbeat=null,this.debugCallMethod="",this.debugCallParams="{}",this.debugCallResult=null,this.debugCallError=null,this.logsLoading=!1,this.logsError=null,this.logsFile=null,this.logsEntries=[],this.logsFilterText="",this.logsLevelFilters={...xh},this.logsAutoFollow=!0,this.logsTruncated=!1,this.logsCursor=null,this.logsLastFetchAt=null,this.logsLimit=500,this.logsMaxBytes=25e4,this.logsAtBottom=!0,this.client=null,this.chatScrollFrame=null,this.chatScrollTimeout=null,this.chatHasAutoScrolled=!1,this.chatUserNearBottom=!0,this.nodesPollInterval=null,this.logsPollInterval=null,this.debugPollInterval=null,this.logsScrollFrame=null,this.toolStreamById=new Map,this.toolStreamOrder=[],this.basePath="",this.popStateHandler=()=>sd(this),this.themeMedia=null,this.themeMediaHandler=null,this.topbarObserver=null}createRenderRoot(){return this}connectedCallback(){super.connectedCallback(),Nh(this)}firstUpdated(){Oh(this)}disconnectedCallback(){Dh(this),super.disconnectedCallback()}updated(e){Bh(this,e)}connect(){gr(this)}handleChatScroll(e){Ml(this,e)}handleLogsScroll(e){Pl(this,e)}exportLogs(e,t){Ol(e,t)}resetToolStream(){Rs(this)}resetChatScroll(){Nl(this)}async loadAssistantIdentity(){await hr(this)}applySettings(e){$e(this,e)}setTab(e){Qc(this,e)}setTheme(e,t){Jc(this,e,t)}async loadOverview(){await Ca(this)}async loadCron(){await Gs(this)}async handleAbortChat(){await La(this)}removeQueuedMessage(e){ld(this,e)}async handleSendChat(e,t){await cd(this,e,t)}async handleWhatsAppStart(e){await Fh(this,e)}async handleWhatsAppWait(){await Uh(this)}async handleWhatsAppLogout(){await Kh(this)}async handleChannelConfigSave(){await Hh(this)}async handleChannelConfigReload(){await zh(this)}handleNostrProfileEdit(e,t){qh(this,e,t)}handleNostrProfileCancel(){Wh(this)}handleNostrProfileFieldChange(e,t){Vh(this,e,t)}async handleNostrProfileSave(){await Yh(this)}async handleNostrProfileImport(){await Qh(this)}handleNostrProfileToggleAdvanced(){Gh(this)}async handleExecApprovalDecision(e){const t=this.execApprovalQueue[0];if(!(!t||!this.client||this.execApprovalBusy)){this.execApprovalBusy=!0,this.execApprovalError=null;try{await this.client.request("exec.approval.resolve",{id:t.id,decision:e}),this.execApprovalQueue=this.execApprovalQueue.filter(n=>n.id!==t.id)}catch(n){this.execApprovalError=`Exec approval failed: ${String(n)}`}finally{this.execApprovalBusy=!1}}}handleOpenSidebar(e){this.sidebarCloseTimer!=null&&(window.clearTimeout(this.sidebarCloseTimer),this.sidebarCloseTimer=null),this.sidebarContent=e,this.sidebarError=null,this.sidebarOpen=!0}handleCloseSidebar(){this.sidebarOpen=!1,this.sidebarCloseTimer!=null&&window.clearTimeout(this.sidebarCloseTimer),this.sidebarCloseTimer=window.setTimeout(()=>{this.sidebarOpen||(this.sidebarContent=null,this.sidebarError=null,this.sidebarCloseTimer=null)},200)}handleSplitRatioChange(e){const t=Math.max(.4,Math.min(.7,e));this.splitRatio=t,this.applySettings({...this.settings,splitRatio:t})}render(){return kh(this)}};b([y()],m.prototype,"settings",2);b([y()],m.prototype,"password",2);b([y()],m.prototype,"tab",2);b([y()],m.prototype,"onboarding",2);b([y()],m.prototype,"connected",2);b([y()],m.prototype,"theme",2);b([y()],m.prototype,"themeResolved",2);b([y()],m.prototype,"hello",2);b([y()],m.prototype,"lastError",2);b([y()],m.prototype,"eventLog",2);b([y()],m.prototype,"assistantName",2);b([y()],m.prototype,"assistantAvatar",2);b([y()],m.prototype,"assistantAgentId",2);b([y()],m.prototype,"sessionKey",2);b([y()],m.prototype,"chatLoading",2);b([y()],m.prototype,"chatSending",2);b([y()],m.prototype,"chatMessage",2);b([y()],m.prototype,"chatMessages",2);b([y()],m.prototype,"chatToolMessages",2);b([y()],m.prototype,"chatStream",2);b([y()],m.prototype,"chatStreamStartedAt",2);b([y()],m.prototype,"chatRunId",2);b([y()],m.prototype,"chatAvatarUrl",2);b([y()],m.prototype,"chatThinkingLevel",2);b([y()],m.prototype,"chatQueue",2);b([y()],m.prototype,"sidebarOpen",2);b([y()],m.prototype,"sidebarContent",2);b([y()],m.prototype,"sidebarError",2);b([y()],m.prototype,"splitRatio",2);b([y()],m.prototype,"nodesLoading",2);b([y()],m.prototype,"nodes",2);b([y()],m.prototype,"devicesLoading",2);b([y()],m.prototype,"devicesError",2);b([y()],m.prototype,"devicesList",2);b([y()],m.prototype,"execApprovalsLoading",2);b([y()],m.prototype,"execApprovalsSaving",2);b([y()],m.prototype,"execApprovalsDirty",2);b([y()],m.prototype,"execApprovalsSnapshot",2);b([y()],m.prototype,"execApprovalsForm",2);b([y()],m.prototype,"execApprovalsSelectedAgent",2);b([y()],m.prototype,"execApprovalsTarget",2);b([y()],m.prototype,"execApprovalsTargetNodeId",2);b([y()],m.prototype,"execApprovalQueue",2);b([y()],m.prototype,"execApprovalBusy",2);b([y()],m.prototype,"execApprovalError",2);b([y()],m.prototype,"configLoading",2);b([y()],m.prototype,"configRaw",2);b([y()],m.prototype,"configValid",2);b([y()],m.prototype,"configIssues",2);b([y()],m.prototype,"configSaving",2);b([y()],m.prototype,"configApplying",2);b([y()],m.prototype,"updateRunning",2);b([y()],m.prototype,"applySessionKey",2);b([y()],m.prototype,"configSnapshot",2);b([y()],m.prototype,"configSchema",2);b([y()],m.prototype,"configSchemaVersion",2);b([y()],m.prototype,"configSchemaLoading",2);b([y()],m.prototype,"configUiHints",2);b([y()],m.prototype,"configForm",2);b([y()],m.prototype,"configFormOriginal",2);b([y()],m.prototype,"configFormDirty",2);b([y()],m.prototype,"configFormMode",2);b([y()],m.prototype,"configSearchQuery",2);b([y()],m.prototype,"configActiveSection",2);b([y()],m.prototype,"configActiveSubsection",2);b([y()],m.prototype,"channelsLoading",2);b([y()],m.prototype,"channelsSnapshot",2);b([y()],m.prototype,"channelsError",2);b([y()],m.prototype,"channelsLastSuccess",2);b([y()],m.prototype,"whatsappLoginMessage",2);b([y()],m.prototype,"whatsappLoginQrDataUrl",2);b([y()],m.prototype,"whatsappLoginConnected",2);b([y()],m.prototype,"whatsappBusy",2);b([y()],m.prototype,"nostrProfileFormState",2);b([y()],m.prototype,"nostrProfileAccountId",2);b([y()],m.prototype,"presenceLoading",2);b([y()],m.prototype,"presenceEntries",2);b([y()],m.prototype,"presenceError",2);b([y()],m.prototype,"presenceStatus",2);b([y()],m.prototype,"agentsLoading",2);b([y()],m.prototype,"agentsList",2);b([y()],m.prototype,"agentsError",2);b([y()],m.prototype,"sessionsLoading",2);b([y()],m.prototype,"sessionsResult",2);b([y()],m.prototype,"sessionsError",2);b([y()],m.prototype,"sessionsFilterActive",2);b([y()],m.prototype,"sessionsFilterLimit",2);b([y()],m.prototype,"sessionsIncludeGlobal",2);b([y()],m.prototype,"sessionsIncludeUnknown",2);b([y()],m.prototype,"cronLoading",2);b([y()],m.prototype,"cronJobs",2);b([y()],m.prototype,"cronStatus",2);b([y()],m.prototype,"cronError",2);b([y()],m.prototype,"cronForm",2);b([y()],m.prototype,"cronRunsJobId",2);b([y()],m.prototype,"cronRuns",2);b([y()],m.prototype,"cronBusy",2);b([y()],m.prototype,"skillsLoading",2);b([y()],m.prototype,"skillsReport",2);b([y()],m.prototype,"skillsError",2);b([y()],m.prototype,"skillsFilter",2);b([y()],m.prototype,"skillEdits",2);b([y()],m.prototype,"skillsBusyKey",2);b([y()],m.prototype,"skillMessages",2);b([y()],m.prototype,"debugLoading",2);b([y()],m.prototype,"debugStatus",2);b([y()],m.prototype,"debugHealth",2);b([y()],m.prototype,"debugModels",2);b([y()],m.prototype,"debugHeartbeat",2);b([y()],m.prototype,"debugCallMethod",2);b([y()],m.prototype,"debugCallParams",2);b([y()],m.prototype,"debugCallResult",2);b([y()],m.prototype,"debugCallError",2);b([y()],m.prototype,"logsLoading",2);b([y()],m.prototype,"logsError",2);b([y()],m.prototype,"logsFile",2);b([y()],m.prototype,"logsEntries",2);b([y()],m.prototype,"logsFilterText",2);b([y()],m.prototype,"logsLevelFilters",2);b([y()],m.prototype,"logsAutoFollow",2);b([y()],m.prototype,"logsTruncated",2);b([y()],m.prototype,"logsCursor",2);b([y()],m.prototype,"logsLastFetchAt",2);b([y()],m.prototype,"logsLimit",2);b([y()],m.prototype,"logsMaxBytes",2);b([y()],m.prototype,"logsAtBottom",2);m=b([Yo("clawdbot-app")],m);
//# sourceMappingURL=index-bYQnHP3a.js.map
