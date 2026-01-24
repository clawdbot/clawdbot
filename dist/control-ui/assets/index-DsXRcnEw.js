(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const i of document.querySelectorAll('link[rel="modulepreload"]'))s(i);new MutationObserver(i=>{for(const o of i)if(o.type==="childList")for(const a of o.addedNodes)a.tagName==="LINK"&&a.rel==="modulepreload"&&s(a)}).observe(document,{childList:!0,subtree:!0});function n(i){const o={};return i.integrity&&(o.integrity=i.integrity),i.referrerPolicy&&(o.referrerPolicy=i.referrerPolicy),i.crossOrigin==="use-credentials"?o.credentials="include":i.crossOrigin==="anonymous"?o.credentials="omit":o.credentials="same-origin",o}function s(i){if(i.ep)return;i.ep=!0;const o=n(i);fetch(i.href,o)}})();const jt=globalThis,Cs=jt.ShadowRoot&&(jt.ShadyCSS===void 0||jt.ShadyCSS.nativeShadow)&&"adoptedStyleSheets"in Document.prototype&&"replace"in CSSStyleSheet.prototype,Es=Symbol(),Ni=new WeakMap;let Go=class{constructor(t,n,s){if(this._$cssResult$=!0,s!==Es)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=t,this.t=n}get styleSheet(){let t=this.o;const n=this.t;if(Cs&&t===void 0){const s=n!==void 0&&n.length===1;s&&(t=Ni.get(n)),t===void 0&&((this.o=t=new CSSStyleSheet).replaceSync(this.cssText),s&&Ni.set(n,t))}return t}toString(){return this.cssText}};const Br=e=>new Go(typeof e=="string"?e:e+"",void 0,Es),Fr=(e,...t)=>{const n=e.length===1?e[0]:t.reduce((s,i,o)=>s+(a=>{if(a._$cssResult$===!0)return a.cssText;if(typeof a=="number")return a;throw Error("Value passed to 'css' function must be a 'css' function result: "+a+". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.")})(i)+e[o+1],e[0]);return new Go(n,e,Es)},Ur=(e,t)=>{if(Cs)e.adoptedStyleSheets=t.map(n=>n instanceof CSSStyleSheet?n:n.styleSheet);else for(const n of t){const s=document.createElement("style"),i=jt.litNonce;i!==void 0&&s.setAttribute("nonce",i),s.textContent=n.cssText,e.appendChild(s)}},Oi=Cs?e=>e:e=>e instanceof CSSStyleSheet?(t=>{let n="";for(const s of t.cssRules)n+=s.cssText;return Br(n)})(e):e;const{is:Kr,defineProperty:Hr,getOwnPropertyDescriptor:zr,getOwnPropertyNames:jr,getOwnPropertySymbols:qr,getPrototypeOf:Wr}=Object,tn=globalThis,Di=tn.trustedTypes,Vr=Di?Di.emptyScript:"",Gr=tn.reactiveElementPolyfillSupport,mt=(e,t)=>e,Vt={toAttribute(e,t){switch(t){case Boolean:e=e?Vr:null;break;case Object:case Array:e=e==null?e:JSON.stringify(e)}return e},fromAttribute(e,t){let n=e;switch(t){case Boolean:n=e!==null;break;case Number:n=e===null?null:Number(e);break;case Object:case Array:try{n=JSON.parse(e)}catch{n=null}}return n}},Is=(e,t)=>!Kr(e,t),Bi={attribute:!0,type:String,converter:Vt,reflect:!1,useDefault:!1,hasChanged:Is};Symbol.metadata??=Symbol("metadata"),tn.litPropertyMetadata??=new WeakMap;let Ge=class extends HTMLElement{static addInitializer(t){this._$Ei(),(this.l??=[]).push(t)}static get observedAttributes(){return this.finalize(),this._$Eh&&[...this._$Eh.keys()]}static createProperty(t,n=Bi){if(n.state&&(n.attribute=!1),this._$Ei(),this.prototype.hasOwnProperty(t)&&((n=Object.create(n)).wrapped=!0),this.elementProperties.set(t,n),!n.noAccessor){const s=Symbol(),i=this.getPropertyDescriptor(t,s,n);i!==void 0&&Hr(this.prototype,t,i)}}static getPropertyDescriptor(t,n,s){const{get:i,set:o}=zr(this.prototype,t)??{get(){return this[n]},set(a){this[n]=a}};return{get:i,set(a){const l=i?.call(this);o?.call(this,a),this.requestUpdate(t,l,s)},configurable:!0,enumerable:!0}}static getPropertyOptions(t){return this.elementProperties.get(t)??Bi}static _$Ei(){if(this.hasOwnProperty(mt("elementProperties")))return;const t=Wr(this);t.finalize(),t.l!==void 0&&(this.l=[...t.l]),this.elementProperties=new Map(t.elementProperties)}static finalize(){if(this.hasOwnProperty(mt("finalized")))return;if(this.finalized=!0,this._$Ei(),this.hasOwnProperty(mt("properties"))){const n=this.properties,s=[...jr(n),...qr(n)];for(const i of s)this.createProperty(i,n[i])}const t=this[Symbol.metadata];if(t!==null){const n=litPropertyMetadata.get(t);if(n!==void 0)for(const[s,i]of n)this.elementProperties.set(s,i)}this._$Eh=new Map;for(const[n,s]of this.elementProperties){const i=this._$Eu(n,s);i!==void 0&&this._$Eh.set(i,n)}this.elementStyles=this.finalizeStyles(this.styles)}static finalizeStyles(t){const n=[];if(Array.isArray(t)){const s=new Set(t.flat(1/0).reverse());for(const i of s)n.unshift(Oi(i))}else t!==void 0&&n.push(Oi(t));return n}static _$Eu(t,n){const s=n.attribute;return s===!1?void 0:typeof s=="string"?s:typeof t=="string"?t.toLowerCase():void 0}constructor(){super(),this._$Ep=void 0,this.isUpdatePending=!1,this.hasUpdated=!1,this._$Em=null,this._$Ev()}_$Ev(){this._$ES=new Promise(t=>this.enableUpdating=t),this._$AL=new Map,this._$E_(),this.requestUpdate(),this.constructor.l?.forEach(t=>t(this))}addController(t){(this._$EO??=new Set).add(t),this.renderRoot!==void 0&&this.isConnected&&t.hostConnected?.()}removeController(t){this._$EO?.delete(t)}_$E_(){const t=new Map,n=this.constructor.elementProperties;for(const s of n.keys())this.hasOwnProperty(s)&&(t.set(s,this[s]),delete this[s]);t.size>0&&(this._$Ep=t)}createRenderRoot(){const t=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return Ur(t,this.constructor.elementStyles),t}connectedCallback(){this.renderRoot??=this.createRenderRoot(),this.enableUpdating(!0),this._$EO?.forEach(t=>t.hostConnected?.())}enableUpdating(t){}disconnectedCallback(){this._$EO?.forEach(t=>t.hostDisconnected?.())}attributeChangedCallback(t,n,s){this._$AK(t,s)}_$ET(t,n){const s=this.constructor.elementProperties.get(t),i=this.constructor._$Eu(t,s);if(i!==void 0&&s.reflect===!0){const o=(s.converter?.toAttribute!==void 0?s.converter:Vt).toAttribute(n,s.type);this._$Em=t,o==null?this.removeAttribute(i):this.setAttribute(i,o),this._$Em=null}}_$AK(t,n){const s=this.constructor,i=s._$Eh.get(t);if(i!==void 0&&this._$Em!==i){const o=s.getPropertyOptions(i),a=typeof o.converter=="function"?{fromAttribute:o.converter}:o.converter?.fromAttribute!==void 0?o.converter:Vt;this._$Em=i;const l=a.fromAttribute(n,o.type);this[i]=l??this._$Ej?.get(i)??l,this._$Em=null}}requestUpdate(t,n,s,i=!1,o){if(t!==void 0){const a=this.constructor;if(i===!1&&(o=this[t]),s??=a.getPropertyOptions(t),!((s.hasChanged??Is)(o,n)||s.useDefault&&s.reflect&&o===this._$Ej?.get(t)&&!this.hasAttribute(a._$Eu(t,s))))return;this.C(t,n,s)}this.isUpdatePending===!1&&(this._$ES=this._$EP())}C(t,n,{useDefault:s,reflect:i,wrapped:o},a){s&&!(this._$Ej??=new Map).has(t)&&(this._$Ej.set(t,a??n??this[t]),o!==!0||a!==void 0)||(this._$AL.has(t)||(this.hasUpdated||s||(n=void 0),this._$AL.set(t,n)),i===!0&&this._$Em!==t&&(this._$Eq??=new Set).add(t))}async _$EP(){this.isUpdatePending=!0;try{await this._$ES}catch(n){Promise.reject(n)}const t=this.scheduleUpdate();return t!=null&&await t,!this.isUpdatePending}scheduleUpdate(){return this.performUpdate()}performUpdate(){if(!this.isUpdatePending)return;if(!this.hasUpdated){if(this.renderRoot??=this.createRenderRoot(),this._$Ep){for(const[i,o]of this._$Ep)this[i]=o;this._$Ep=void 0}const s=this.constructor.elementProperties;if(s.size>0)for(const[i,o]of s){const{wrapped:a}=o,l=this[i];a!==!0||this._$AL.has(i)||l===void 0||this.C(i,void 0,o,l)}}let t=!1;const n=this._$AL;try{t=this.shouldUpdate(n),t?(this.willUpdate(n),this._$EO?.forEach(s=>s.hostUpdate?.()),this.update(n)):this._$EM()}catch(s){throw t=!1,this._$EM(),s}t&&this._$AE(n)}willUpdate(t){}_$AE(t){this._$EO?.forEach(n=>n.hostUpdated?.()),this.hasUpdated||(this.hasUpdated=!0,this.firstUpdated(t)),this.updated(t)}_$EM(){this._$AL=new Map,this.isUpdatePending=!1}get updateComplete(){return this.getUpdateComplete()}getUpdateComplete(){return this._$ES}shouldUpdate(t){return!0}update(t){this._$Eq&&=this._$Eq.forEach(n=>this._$ET(n,this[n])),this._$EM()}updated(t){}firstUpdated(t){}};Ge.elementStyles=[],Ge.shadowRootOptions={mode:"open"},Ge[mt("elementProperties")]=new Map,Ge[mt("finalized")]=new Map,Gr?.({ReactiveElement:Ge}),(tn.reactiveElementVersions??=[]).push("2.1.2");const Ls=globalThis,Fi=e=>e,Gt=Ls.trustedTypes,Ui=Gt?Gt.createPolicy("lit-html",{createHTML:e=>e}):void 0,Yo="$lit$",we=`lit$${Math.random().toFixed(9).slice(2)}$`,Qo="?"+we,Yr=`<${Qo}>`,Ne=document,wt=()=>Ne.createComment(""),$t=e=>e===null||typeof e!="object"&&typeof e!="function",Rs=Array.isArray,Qr=e=>Rs(e)||typeof e?.[Symbol.iterator]=="function",Nn=`[ 	
\f\r]`,at=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,Ki=/-->/g,Hi=/>/g,Ee=RegExp(`>|${Nn}(?:([^\\s"'>=/]+)(${Nn}*=${Nn}*(?:[^ 	
\f\r"'\`<>=]|("|')|))|$)`,"g"),zi=/'/g,ji=/"/g,Jo=/^(?:script|style|textarea|title)$/i,Jr=e=>(t,...n)=>({_$litType$:e,strings:t,values:n}),c=Jr(1),xe=Symbol.for("lit-noChange"),g=Symbol.for("lit-nothing"),qi=new WeakMap,Me=Ne.createTreeWalker(Ne,129);function Zo(e,t){if(!Rs(e)||!e.hasOwnProperty("raw"))throw Error("invalid template strings array");return Ui!==void 0?Ui.createHTML(t):t}const Zr=(e,t)=>{const n=e.length-1,s=[];let i,o=t===2?"<svg>":t===3?"<math>":"",a=at;for(let l=0;l<n;l++){const r=e[l];let p,d,u=-1,h=0;for(;h<r.length&&(a.lastIndex=h,d=a.exec(r),d!==null);)h=a.lastIndex,a===at?d[1]==="!--"?a=Ki:d[1]!==void 0?a=Hi:d[2]!==void 0?(Jo.test(d[2])&&(i=RegExp("</"+d[2],"g")),a=Ee):d[3]!==void 0&&(a=Ee):a===Ee?d[0]===">"?(a=i??at,u=-1):d[1]===void 0?u=-2:(u=a.lastIndex-d[2].length,p=d[1],a=d[3]===void 0?Ee:d[3]==='"'?ji:zi):a===ji||a===zi?a=Ee:a===Ki||a===Hi?a=at:(a=Ee,i=void 0);const v=a===Ee&&e[l+1].startsWith("/>")?" ":"";o+=a===at?r+Yr:u>=0?(s.push(p),r.slice(0,u)+Yo+r.slice(u)+we+v):r+we+(u===-2?l:v)}return[Zo(e,o+(e[n]||"<?>")+(t===2?"</svg>":t===3?"</math>":"")),s]};let ns=class Xo{constructor({strings:t,_$litType$:n},s){let i;this.parts=[];let o=0,a=0;const l=t.length-1,r=this.parts,[p,d]=Zr(t,n);if(this.el=Xo.createElement(p,s),Me.currentNode=this.el.content,n===2||n===3){const u=this.el.content.firstChild;u.replaceWith(...u.childNodes)}for(;(i=Me.nextNode())!==null&&r.length<l;){if(i.nodeType===1){if(i.hasAttributes())for(const u of i.getAttributeNames())if(u.endsWith(Yo)){const h=d[a++],v=i.getAttribute(u).split(we),w=/([.?@])?(.*)/.exec(h);r.push({type:1,index:o,name:w[2],strings:v,ctor:w[1]==="."?el:w[1]==="?"?tl:w[1]==="@"?nl:sn}),i.removeAttribute(u)}else u.startsWith(we)&&(r.push({type:6,index:o}),i.removeAttribute(u));if(Jo.test(i.tagName)){const u=i.textContent.split(we),h=u.length-1;if(h>0){i.textContent=Gt?Gt.emptyScript:"";for(let v=0;v<h;v++)i.append(u[v],wt()),Me.nextNode(),r.push({type:2,index:++o});i.append(u[h],wt())}}}else if(i.nodeType===8)if(i.data===Qo)r.push({type:2,index:o});else{let u=-1;for(;(u=i.data.indexOf(we,u+1))!==-1;)r.push({type:7,index:o}),u+=we.length-1}o++}}static createElement(t,n){const s=Ne.createElement("template");return s.innerHTML=t,s}};function Je(e,t,n=e,s){if(t===xe)return t;let i=s!==void 0?n._$Co?.[s]:n._$Cl;const o=$t(t)?void 0:t._$litDirective$;return i?.constructor!==o&&(i?._$AO?.(!1),o===void 0?i=void 0:(i=new o(e),i._$AT(e,n,s)),s!==void 0?(n._$Co??=[])[s]=i:n._$Cl=i),i!==void 0&&(t=Je(e,i._$AS(e,t.values),i,s)),t}class Xr{constructor(t,n){this._$AV=[],this._$AN=void 0,this._$AD=t,this._$AM=n}get parentNode(){return this._$AM.parentNode}get _$AU(){return this._$AM._$AU}u(t){const{el:{content:n},parts:s}=this._$AD,i=(t?.creationScope??Ne).importNode(n,!0);Me.currentNode=i;let o=Me.nextNode(),a=0,l=0,r=s[0];for(;r!==void 0;){if(a===r.index){let p;r.type===2?p=new nn(o,o.nextSibling,this,t):r.type===1?p=new r.ctor(o,r.name,r.strings,this,t):r.type===6&&(p=new sl(o,this,t)),this._$AV.push(p),r=s[++l]}a!==r?.index&&(o=Me.nextNode(),a++)}return Me.currentNode=Ne,i}p(t){let n=0;for(const s of this._$AV)s!==void 0&&(s.strings!==void 0?(s._$AI(t,s,n),n+=s.strings.length-2):s._$AI(t[n])),n++}}let nn=class ea{get _$AU(){return this._$AM?._$AU??this._$Cv}constructor(t,n,s,i){this.type=2,this._$AH=g,this._$AN=void 0,this._$AA=t,this._$AB=n,this._$AM=s,this.options=i,this._$Cv=i?.isConnected??!0}get parentNode(){let t=this._$AA.parentNode;const n=this._$AM;return n!==void 0&&t?.nodeType===11&&(t=n.parentNode),t}get startNode(){return this._$AA}get endNode(){return this._$AB}_$AI(t,n=this){t=Je(this,t,n),$t(t)?t===g||t==null||t===""?(this._$AH!==g&&this._$AR(),this._$AH=g):t!==this._$AH&&t!==xe&&this._(t):t._$litType$!==void 0?this.$(t):t.nodeType!==void 0?this.T(t):Qr(t)?this.k(t):this._(t)}O(t){return this._$AA.parentNode.insertBefore(t,this._$AB)}T(t){this._$AH!==t&&(this._$AR(),this._$AH=this.O(t))}_(t){this._$AH!==g&&$t(this._$AH)?this._$AA.nextSibling.data=t:this.T(Ne.createTextNode(t)),this._$AH=t}$(t){const{values:n,_$litType$:s}=t,i=typeof s=="number"?this._$AC(t):(s.el===void 0&&(s.el=ns.createElement(Zo(s.h,s.h[0]),this.options)),s);if(this._$AH?._$AD===i)this._$AH.p(n);else{const o=new Xr(i,this),a=o.u(this.options);o.p(n),this.T(a),this._$AH=o}}_$AC(t){let n=qi.get(t.strings);return n===void 0&&qi.set(t.strings,n=new ns(t)),n}k(t){Rs(this._$AH)||(this._$AH=[],this._$AR());const n=this._$AH;let s,i=0;for(const o of t)i===n.length?n.push(s=new ea(this.O(wt()),this.O(wt()),this,this.options)):s=n[i],s._$AI(o),i++;i<n.length&&(this._$AR(s&&s._$AB.nextSibling,i),n.length=i)}_$AR(t=this._$AA.nextSibling,n){for(this._$AP?.(!1,!0,n);t!==this._$AB;){const s=Fi(t).nextSibling;Fi(t).remove(),t=s}}setConnected(t){this._$AM===void 0&&(this._$Cv=t,this._$AP?.(t))}};class sn{get tagName(){return this.element.tagName}get _$AU(){return this._$AM._$AU}constructor(t,n,s,i,o){this.type=1,this._$AH=g,this._$AN=void 0,this.element=t,this.name=n,this._$AM=i,this.options=o,s.length>2||s[0]!==""||s[1]!==""?(this._$AH=Array(s.length-1).fill(new String),this.strings=s):this._$AH=g}_$AI(t,n=this,s,i){const o=this.strings;let a=!1;if(o===void 0)t=Je(this,t,n,0),a=!$t(t)||t!==this._$AH&&t!==xe,a&&(this._$AH=t);else{const l=t;let r,p;for(t=o[0],r=0;r<o.length-1;r++)p=Je(this,l[s+r],n,r),p===xe&&(p=this._$AH[r]),a||=!$t(p)||p!==this._$AH[r],p===g?t=g:t!==g&&(t+=(p??"")+o[r+1]),this._$AH[r]=p}a&&!i&&this.j(t)}j(t){t===g?this.element.removeAttribute(this.name):this.element.setAttribute(this.name,t??"")}}let el=class extends sn{constructor(){super(...arguments),this.type=3}j(t){this.element[this.name]=t===g?void 0:t}},tl=class extends sn{constructor(){super(...arguments),this.type=4}j(t){this.element.toggleAttribute(this.name,!!t&&t!==g)}},nl=class extends sn{constructor(t,n,s,i,o){super(t,n,s,i,o),this.type=5}_$AI(t,n=this){if((t=Je(this,t,n,0)??g)===xe)return;const s=this._$AH,i=t===g&&s!==g||t.capture!==s.capture||t.once!==s.once||t.passive!==s.passive,o=t!==g&&(s===g||i);i&&this.element.removeEventListener(this.name,this,s),o&&this.element.addEventListener(this.name,this,t),this._$AH=t}handleEvent(t){typeof this._$AH=="function"?this._$AH.call(this.options?.host??this.element,t):this._$AH.handleEvent(t)}},sl=class{constructor(t,n,s){this.element=t,this.type=6,this._$AN=void 0,this._$AM=n,this.options=s}get _$AU(){return this._$AM._$AU}_$AI(t){Je(this,t)}};const il={I:nn},ol=Ls.litHtmlPolyfillSupport;ol?.(ns,nn),(Ls.litHtmlVersions??=[]).push("3.3.2");const al=(e,t,n)=>{const s=n?.renderBefore??t;let i=s._$litPart$;if(i===void 0){const o=n?.renderBefore??null;s._$litPart$=i=new nn(t.insertBefore(wt(),o),o,void 0,n??{})}return i._$AI(e),i};const Ms=globalThis;let Qe=class extends Ge{constructor(){super(...arguments),this.renderOptions={host:this},this._$Do=void 0}createRenderRoot(){const t=super.createRenderRoot();return this.renderOptions.renderBefore??=t.firstChild,t}update(t){const n=this.render();this.hasUpdated||(this.renderOptions.isConnected=this.isConnected),super.update(t),this._$Do=al(n,this.renderRoot,this.renderOptions)}connectedCallback(){super.connectedCallback(),this._$Do?.setConnected(!0)}disconnectedCallback(){super.disconnectedCallback(),this._$Do?.setConnected(!1)}render(){return xe}};Qe._$litElement$=!0,Qe.finalized=!0,Ms.litElementHydrateSupport?.({LitElement:Qe});const rl=Ms.litElementPolyfillSupport;rl?.({LitElement:Qe});(Ms.litElementVersions??=[]).push("4.2.2");const ta=e=>(t,n)=>{n!==void 0?n.addInitializer(()=>{customElements.define(e,t)}):customElements.define(e,t)};const ll={attribute:!0,type:String,converter:Vt,reflect:!1,hasChanged:Is},cl=(e=ll,t,n)=>{const{kind:s,metadata:i}=n;let o=globalThis.litPropertyMetadata.get(i);if(o===void 0&&globalThis.litPropertyMetadata.set(i,o=new Map),s==="setter"&&((e=Object.create(e)).wrapped=!0),o.set(n.name,e),s==="accessor"){const{name:a}=n;return{set(l){const r=t.get.call(this);t.set.call(this,l),this.requestUpdate(a,r,e,!0,l)},init(l){return l!==void 0&&this.C(a,void 0,e,l),l}}}if(s==="setter"){const{name:a}=n;return function(l){const r=this[a];t.call(this,l),this.requestUpdate(a,r,e,!0,l)}}throw Error("Unsupported decorator location: "+s)};function on(e){return(t,n)=>typeof n=="object"?cl(e,t,n):((s,i,o)=>{const a=i.hasOwnProperty(o);return i.constructor.createProperty(o,s),a?Object.getOwnPropertyDescriptor(i,o):void 0})(e,t,n)}function y(e){return on({...e,state:!0,attribute:!1})}const dl=50,ul=200,pl="Assistant";function Wi(e,t){if(typeof e!="string")return;const n=e.trim();if(n)return n.length<=t?n:n.slice(0,t)}function ss(e){const t=Wi(e?.name,dl)??pl,n=Wi(e?.avatar??void 0,ul)??null;return{agentId:typeof e?.agentId=="string"&&e.agentId.trim()?e.agentId.trim():null,name:t,avatar:n}}function fl(){return ss(typeof window>"u"?{}:{name:window.__CLAWDBOT_ASSISTANT_NAME__,avatar:window.__CLAWDBOT_ASSISTANT_AVATAR__})}const na="clawdbot.control.settings.v1";function hl(){const t={gatewayUrl:`${location.protocol==="https:"?"wss":"ws"}://${location.host}`,token:"",sessionKey:"main",lastActiveSessionKey:"main",theme:"system",chatFocusMode:!1,chatShowThinking:!0,splitRatio:.6,navCollapsed:!1,navGroupsCollapsed:{}};try{const n=localStorage.getItem(na);if(!n)return t;const s=JSON.parse(n);return{gatewayUrl:typeof s.gatewayUrl=="string"&&s.gatewayUrl.trim()?s.gatewayUrl.trim():t.gatewayUrl,token:typeof s.token=="string"?s.token:t.token,sessionKey:typeof s.sessionKey=="string"&&s.sessionKey.trim()?s.sessionKey.trim():t.sessionKey,lastActiveSessionKey:typeof s.lastActiveSessionKey=="string"&&s.lastActiveSessionKey.trim()?s.lastActiveSessionKey.trim():typeof s.sessionKey=="string"&&s.sessionKey.trim()||t.lastActiveSessionKey,theme:s.theme==="light"||s.theme==="dark"||s.theme==="system"?s.theme:t.theme,chatFocusMode:typeof s.chatFocusMode=="boolean"?s.chatFocusMode:t.chatFocusMode,chatShowThinking:typeof s.chatShowThinking=="boolean"?s.chatShowThinking:t.chatShowThinking,splitRatio:typeof s.splitRatio=="number"&&s.splitRatio>=.4&&s.splitRatio<=.7?s.splitRatio:t.splitRatio,navCollapsed:typeof s.navCollapsed=="boolean"?s.navCollapsed:t.navCollapsed,navGroupsCollapsed:typeof s.navGroupsCollapsed=="object"&&s.navGroupsCollapsed!==null?s.navGroupsCollapsed:t.navGroupsCollapsed}}catch{return t}}function gl(e){localStorage.setItem(na,JSON.stringify(e))}function sa(e){const t=(e??"").trim();if(!t)return null;const n=t.split(":").filter(Boolean);if(n.length<3||n[0]!=="agent")return null;const s=n[1]?.trim(),i=n.slice(2).join(":");return!s||!i?null:{agentId:s,rest:i}}const vl=[{label:"Chat",tabs:["chat"]},{label:"Control",tabs:["overview","channels","instances","sessions","cron"]},{label:"Agent",tabs:["skills","nodes"]},{label:"Settings",tabs:["config","debug","logs"]}],ia={overview:"/overview",channels:"/channels",instances:"/instances",sessions:"/sessions",cron:"/cron",skills:"/skills",nodes:"/nodes",chat:"/chat",config:"/config",debug:"/debug",logs:"/logs"},oa=new Map(Object.entries(ia).map(([e,t])=>[t,e]));function an(e){if(!e)return"";let t=e.trim();return t.startsWith("/")||(t=`/${t}`),t==="/"?"":(t.endsWith("/")&&(t=t.slice(0,-1)),t)}function kt(e){if(!e)return"/";let t=e.trim();return t.startsWith("/")||(t=`/${t}`),t.length>1&&t.endsWith("/")&&(t=t.slice(0,-1)),t}function Ps(e,t=""){const n=an(t),s=ia[e];return n?`${n}${s}`:s}function aa(e,t=""){const n=an(t);let s=e||"/";n&&(s===n?s="/":s.startsWith(`${n}/`)&&(s=s.slice(n.length)));let i=kt(s).toLowerCase();return i.endsWith("/index.html")&&(i="/"),i==="/"?"chat":oa.get(i)??null}function ml(e){let t=kt(e);if(t.endsWith("/index.html")&&(t=kt(t.slice(0,-11))),t==="/")return"";const n=t.split("/").filter(Boolean);if(n.length===0)return"";for(let s=0;s<n.length;s++){const i=`/${n.slice(s).join("/")}`.toLowerCase();if(oa.has(i)){const o=n.slice(0,s);return o.length?`/${o.join("/")}`:""}}return`/${n.join("/")}`}function bl(e){switch(e){case"chat":return"💬";case"overview":return"📊";case"channels":return"🔗";case"instances":return"📡";case"sessions":return"📄";case"cron":return"⏰";case"skills":return"⚡️";case"nodes":return"🖥️";case"config":return"⚙️";case"debug":return"🐞";case"logs":return"🧾";default:return"📁"}}function is(e){switch(e){case"overview":return"Overview";case"channels":return"Channels";case"instances":return"Instances";case"sessions":return"Sessions";case"cron":return"Cron Jobs";case"skills":return"Skills";case"nodes":return"Nodes";case"chat":return"Chat";case"config":return"Config";case"debug":return"Debug";case"logs":return"Logs";default:return"Control"}}function yl(e){switch(e){case"overview":return"Gateway status, entry points, and a fast health read.";case"channels":return"Manage channels and settings.";case"instances":return"Presence beacons from connected clients and nodes.";case"sessions":return"Inspect active sessions and adjust per-session defaults.";case"cron":return"Schedule wakeups and recurring agent runs.";case"skills":return"Manage skill availability and API key injection.";case"nodes":return"Paired devices, capabilities, and command exposure.";case"chat":return"Direct gateway chat session for quick interventions.";case"config":return"Edit ~/.clawdbot/clawdbot.json safely.";case"debug":return"Gateway snapshots, events, and manual RPC calls.";case"logs":return"Live tail of the gateway file logs.";default:return""}}function xt(e){return!e&&e!==0?"n/a":new Date(e).toLocaleString()}function O(e){if(!e&&e!==0)return"n/a";const t=Date.now()-e;if(t<0)return"just now";const n=Math.round(t/1e3);if(n<60)return`${n}s ago`;const s=Math.round(n/60);if(s<60)return`${s}m ago`;const i=Math.round(s/60);return i<48?`${i}h ago`:`${Math.round(i/24)}d ago`}function ra(e){if(!e&&e!==0)return"n/a";if(e<1e3)return`${e}ms`;const t=Math.round(e/1e3);if(t<60)return`${t}s`;const n=Math.round(t/60);if(n<60)return`${n}m`;const s=Math.round(n/60);return s<48?`${s}h`:`${Math.round(s/24)}d`}function os(e){return!e||e.length===0?"none":e.filter(t=>!!(t&&t.trim())).join(", ")}function as(e,t=120){return e.length<=t?e:`${e.slice(0,Math.max(0,t-1))}…`}function la(e,t){return e.length<=t?{text:e,truncated:!1,total:e.length}:{text:e.slice(0,Math.max(0,t)),truncated:!0,total:e.length}}function Yt(e,t){const n=Number(e);return Number.isFinite(n)?n:t}const On=/<\s*\/?\s*think(?:ing)?\s*>/gi,Vi=/<\s*think(?:ing)?\s*>/i,Gi=/<\s*\/\s*think(?:ing)?\s*>/i;function Dn(e){if(!e)return e;const t=Vi.test(e),n=Gi.test(e);if(!t&&!n)return e;if(t!==n)return t?e.replace(Vi,"").trimStart():e.replace(Gi,"").trimStart();if(!On.test(e))return e;On.lastIndex=0;let s="",i=0,o=!1;for(const a of e.matchAll(On)){const l=a.index??0;o||(s+=e.slice(i,l)),o=!a[0].toLowerCase().includes("/"),i=l+a[0].length}return o||(s+=e.slice(i)),s.trimStart()}const wl=/^\[([^\]]+)\]\s*/,$l=["WebChat","WhatsApp","Telegram","Signal","Slack","Discord","iMessage","Teams","Matrix","Zalo","Zalo Personal","BlueBubbles"],Bn=new WeakMap,Fn=new WeakMap;function kl(e){return/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\b/.test(e)||/\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/.test(e)?!0:$l.some(t=>e.startsWith(`${t} `))}function Un(e){const t=e.match(wl);if(!t)return e;const n=t[1]??"";return kl(n)?e.slice(t[0].length):e}function rs(e){const t=e,n=typeof t.role=="string"?t.role:"",s=t.content;if(typeof s=="string")return n==="assistant"?Dn(s):Un(s);if(Array.isArray(s)){const i=s.map(o=>{const a=o;return a.type==="text"&&typeof a.text=="string"?a.text:null}).filter(o=>typeof o=="string");if(i.length>0){const o=i.join(`
`);return n==="assistant"?Dn(o):Un(o)}}return typeof t.text=="string"?n==="assistant"?Dn(t.text):Un(t.text):null}function ca(e){if(!e||typeof e!="object")return rs(e);const t=e;if(Bn.has(t))return Bn.get(t)??null;const n=rs(e);return Bn.set(t,n),n}function Yi(e){const n=e.content,s=[];if(Array.isArray(n))for(const l of n){const r=l;if(r.type==="thinking"&&typeof r.thinking=="string"){const p=r.thinking.trim();p&&s.push(p)}}if(s.length>0)return s.join(`
`);const i=Al(e);if(!i)return null;const a=[...i.matchAll(/<\s*think(?:ing)?\s*>([\s\S]*?)<\s*\/\s*think(?:ing)?\s*>/gi)].map(l=>(l[1]??"").trim()).filter(Boolean);return a.length>0?a.join(`
`):null}function xl(e){if(!e||typeof e!="object")return Yi(e);const t=e;if(Fn.has(t))return Fn.get(t)??null;const n=Yi(e);return Fn.set(t,n),n}function Al(e){const t=e,n=t.content;if(typeof n=="string")return n;if(Array.isArray(n)){const s=n.map(i=>{const o=i;return o.type==="text"&&typeof o.text=="string"?o.text:null}).filter(i=>typeof i=="string");if(s.length>0)return s.join(`
`)}return typeof t.text=="string"?t.text:null}function Sl(e){const t=e.trim();if(!t)return"";const n=t.split(/\r?\n/).map(s=>s.trim()).filter(Boolean).map(s=>`_${s}_`);return n.length?["_Reasoning:_",...n].join(`
`):""}function Qi(e){e[6]=e[6]&15|64,e[8]=e[8]&63|128;let t="";for(let n=0;n<e.length;n++)t+=e[n].toString(16).padStart(2,"0");return`${t.slice(0,8)}-${t.slice(8,12)}-${t.slice(12,16)}-${t.slice(16,20)}-${t.slice(20)}`}function _l(){const e=new Uint8Array(16),t=Date.now();for(let n=0;n<e.length;n++)e[n]=Math.floor(Math.random()*256);return e[0]^=t&255,e[1]^=t>>>8&255,e[2]^=t>>>16&255,e[3]^=t>>>24&255,e}function Ns(e=globalThis.crypto){if(e&&typeof e.randomUUID=="function")return e.randomUUID();if(e&&typeof e.getRandomValues=="function"){const t=new Uint8Array(16);return e.getRandomValues(t),Qi(t)}return Qi(_l())}async function Ze(e){if(!(!e.client||!e.connected)){e.chatLoading=!0,e.lastError=null;try{const t=await e.client.request("chat.history",{sessionKey:e.sessionKey,limit:200});e.chatMessages=Array.isArray(t.messages)?t.messages:[],e.chatThinkingLevel=t.thinkingLevel??null}catch(t){e.lastError=String(t)}finally{e.chatLoading=!1}}}async function Tl(e,t){if(!e.client||!e.connected)return!1;const n=t.trim();if(!n)return!1;const s=Date.now();e.chatMessages=[...e.chatMessages,{role:"user",content:[{type:"text",text:n}],timestamp:s}],e.chatSending=!0,e.lastError=null;const i=Ns();e.chatRunId=i,e.chatStream="",e.chatStreamStartedAt=s;try{return await e.client.request("chat.send",{sessionKey:e.sessionKey,message:n,deliver:!1,idempotencyKey:i}),!0}catch(o){const a=String(o);return e.chatRunId=null,e.chatStream=null,e.chatStreamStartedAt=null,e.lastError=a,e.chatMessages=[...e.chatMessages,{role:"assistant",content:[{type:"text",text:"Error: "+a}],timestamp:Date.now()}],!1}finally{e.chatSending=!1}}async function Cl(e){if(!e.client||!e.connected)return!1;const t=e.chatRunId;try{return await e.client.request("chat.abort",t?{sessionKey:e.sessionKey,runId:t}:{sessionKey:e.sessionKey}),!0}catch(n){return e.lastError=String(n),!1}}function El(e,t){if(!t||t.sessionKey!==e.sessionKey||t.runId&&e.chatRunId&&t.runId!==e.chatRunId)return null;if(t.state==="delta"){const n=rs(t.message);if(typeof n=="string"){const s=e.chatStream??"";(!s||n.length>=s.length)&&(e.chatStream=n)}}else t.state==="final"||t.state==="aborted"?(e.chatStream=null,e.chatRunId=null,e.chatStreamStartedAt=null):t.state==="error"&&(e.chatStream=null,e.chatRunId=null,e.chatStreamStartedAt=null,e.lastError=t.errorMessage??"chat error");return t.state}async function nt(e){if(!(!e.client||!e.connected)&&!e.sessionsLoading){e.sessionsLoading=!0,e.sessionsError=null;try{const t={includeGlobal:e.sessionsIncludeGlobal,includeUnknown:e.sessionsIncludeUnknown},n=Yt(e.sessionsFilterActive,0),s=Yt(e.sessionsFilterLimit,0);n>0&&(t.activeMinutes=n),s>0&&(t.limit=s);const i=await e.client.request("sessions.list",t);i&&(e.sessionsResult=i)}catch(t){e.sessionsError=String(t)}finally{e.sessionsLoading=!1}}}async function Il(e,t,n){if(!e.client||!e.connected)return;const s={key:t};"label"in n&&(s.label=n.label),"thinkingLevel"in n&&(s.thinkingLevel=n.thinkingLevel),"verboseLevel"in n&&(s.verboseLevel=n.verboseLevel),"reasoningLevel"in n&&(s.reasoningLevel=n.reasoningLevel);try{await e.client.request("sessions.patch",s),await nt(e)}catch(i){e.sessionsError=String(i)}}async function Ll(e,t){if(!(!e.client||!e.connected||e.sessionsLoading||!window.confirm(`Delete session "${t}"?

Deletes the session entry and archives its transcript.`))){e.sessionsLoading=!0,e.sessionsError=null;try{await e.client.request("sessions.delete",{key:t,deleteTranscript:!0}),await nt(e)}catch(s){e.sessionsError=String(s)}finally{e.sessionsLoading=!1}}}const Ji=50,Rl=80,Ml=12e4;function Pl(e){if(!e||typeof e!="object")return null;const t=e;if(typeof t.text=="string")return t.text;const n=t.content;if(!Array.isArray(n))return null;const s=n.map(i=>{if(!i||typeof i!="object")return null;const o=i;return o.type==="text"&&typeof o.text=="string"?o.text:null}).filter(i=>!!i);return s.length===0?null:s.join(`
`)}function Zi(e){if(e==null)return null;if(typeof e=="number"||typeof e=="boolean")return String(e);const t=Pl(e);let n;if(typeof e=="string")n=e;else if(t)n=t;else try{n=JSON.stringify(e,null,2)}catch{n=String(e)}const s=la(n,Ml);return s.truncated?`${s.text}

… truncated (${s.total} chars, showing first ${s.text.length}).`:s.text}function Nl(e){const t=[];return t.push({type:"toolcall",name:e.name,arguments:e.args??{}}),e.output&&t.push({type:"toolresult",name:e.name,text:e.output}),{role:"assistant",toolCallId:e.toolCallId,runId:e.runId,content:t,timestamp:e.startedAt}}function Ol(e){if(e.toolStreamOrder.length<=Ji)return;const t=e.toolStreamOrder.length-Ji,n=e.toolStreamOrder.splice(0,t);for(const s of n)e.toolStreamById.delete(s)}function Dl(e){e.chatToolMessages=e.toolStreamOrder.map(t=>e.toolStreamById.get(t)?.message).filter(t=>!!t)}function ls(e){e.toolStreamSyncTimer!=null&&(clearTimeout(e.toolStreamSyncTimer),e.toolStreamSyncTimer=null),Dl(e)}function Bl(e,t=!1){if(t){ls(e);return}e.toolStreamSyncTimer==null&&(e.toolStreamSyncTimer=window.setTimeout(()=>ls(e),Rl))}function Os(e){e.toolStreamById.clear(),e.toolStreamOrder=[],e.chatToolMessages=[],ls(e)}const Fl=5e3;function Ul(e,t){const n=t.data??{},s=typeof n.phase=="string"?n.phase:"";e.compactionClearTimer!=null&&(window.clearTimeout(e.compactionClearTimer),e.compactionClearTimer=null),s==="start"?e.compactionStatus={active:!0,startedAt:Date.now(),completedAt:null}:s==="end"&&(e.compactionStatus={active:!1,startedAt:e.compactionStatus?.startedAt??null,completedAt:Date.now()},e.compactionClearTimer=window.setTimeout(()=>{e.compactionStatus=null,e.compactionClearTimer=null},Fl))}function Kl(e,t){if(!t)return;if(t.stream==="compaction"){Ul(e,t);return}if(t.stream!=="tool")return;const n=typeof t.sessionKey=="string"?t.sessionKey:void 0;if(n&&n!==e.sessionKey||!n&&e.chatRunId&&t.runId!==e.chatRunId||e.chatRunId&&t.runId!==e.chatRunId||!e.chatRunId)return;const s=t.data??{},i=typeof s.toolCallId=="string"?s.toolCallId:"";if(!i)return;const o=typeof s.name=="string"?s.name:"tool",a=typeof s.phase=="string"?s.phase:"",l=a==="start"?s.args:void 0,r=a==="update"?Zi(s.partialResult):a==="result"?Zi(s.result):void 0,p=Date.now();let d=e.toolStreamById.get(i);d?(d.name=o,l!==void 0&&(d.args=l),r!==void 0&&(d.output=r),d.updatedAt=p):(d={toolCallId:i,runId:t.runId,sessionKey:n,name:o,args:l,output:r,startedAt:typeof t.ts=="number"?t.ts:p,updatedAt:p,message:{}},e.toolStreamById.set(i,d),e.toolStreamOrder.push(i)),d.message=Nl(d),Ol(e),Bl(e,a==="result")}function rn(e,t=!1){e.chatScrollFrame&&cancelAnimationFrame(e.chatScrollFrame),e.chatScrollTimeout!=null&&(clearTimeout(e.chatScrollTimeout),e.chatScrollTimeout=null);const n=()=>{const s=e.querySelector(".chat-thread");if(s){const i=getComputedStyle(s).overflowY;if(i==="auto"||i==="scroll"||s.scrollHeight-s.clientHeight>1)return s}return document.scrollingElement??document.documentElement};e.updateComplete.then(()=>{e.chatScrollFrame=requestAnimationFrame(()=>{e.chatScrollFrame=null;const s=n();if(!s)return;const i=s.scrollHeight-s.scrollTop-s.clientHeight;if(!(t||e.chatUserNearBottom||i<200))return;t&&(e.chatHasAutoScrolled=!0),s.scrollTop=s.scrollHeight,e.chatUserNearBottom=!0;const a=t?150:120;e.chatScrollTimeout=window.setTimeout(()=>{e.chatScrollTimeout=null;const l=n();if(!l)return;const r=l.scrollHeight-l.scrollTop-l.clientHeight;(t||e.chatUserNearBottom||r<200)&&(l.scrollTop=l.scrollHeight,e.chatUserNearBottom=!0)},a)})})}function da(e,t=!1){e.logsScrollFrame&&cancelAnimationFrame(e.logsScrollFrame),e.updateComplete.then(()=>{e.logsScrollFrame=requestAnimationFrame(()=>{e.logsScrollFrame=null;const n=e.querySelector(".log-stream");if(!n)return;const s=n.scrollHeight-n.scrollTop-n.clientHeight;(t||s<80)&&(n.scrollTop=n.scrollHeight)})})}function Hl(e,t){const n=t.currentTarget;if(!n)return;const s=n.scrollHeight-n.scrollTop-n.clientHeight;e.chatUserNearBottom=s<200}function zl(e,t){const n=t.currentTarget;if(!n)return;const s=n.scrollHeight-n.scrollTop-n.clientHeight;e.logsAtBottom=s<80}function jl(e){e.chatHasAutoScrolled=!1,e.chatUserNearBottom=!0}function ql(e,t){if(e.length===0)return;const n=new Blob([`${e.join(`
`)}
`],{type:"text/plain"}),s=URL.createObjectURL(n),i=document.createElement("a"),o=new Date().toISOString().slice(0,19).replace(/[:T]/g,"-");i.href=s,i.download=`clawdbot-logs-${t}-${o}.log`,i.click(),URL.revokeObjectURL(s)}function Wl(e){if(typeof ResizeObserver>"u")return;const t=e.querySelector(".topbar");if(!t)return;const n=()=>{const{height:s}=t.getBoundingClientRect();e.style.setProperty("--topbar-height",`${s}px`)};n(),e.topbarObserver=new ResizeObserver(()=>n()),e.topbarObserver.observe(t)}function Oe(e){return typeof structuredClone=="function"?structuredClone(e):JSON.parse(JSON.stringify(e))}function Xe(e){return`${JSON.stringify(e,null,2).trimEnd()}
`}function ua(e,t,n){if(t.length===0)return;let s=e;for(let o=0;o<t.length-1;o+=1){const a=t[o],l=t[o+1];if(typeof a=="number"){if(!Array.isArray(s))return;s[a]==null&&(s[a]=typeof l=="number"?[]:{}),s=s[a]}else{if(typeof s!="object"||s==null)return;const r=s;r[a]==null&&(r[a]=typeof l=="number"?[]:{}),s=r[a]}}const i=t[t.length-1];if(typeof i=="number"){Array.isArray(s)&&(s[i]=n);return}typeof s=="object"&&s!=null&&(s[i]=n)}function pa(e,t){if(t.length===0)return;let n=e;for(let i=0;i<t.length-1;i+=1){const o=t[i];if(typeof o=="number"){if(!Array.isArray(n))return;n=n[o]}else{if(typeof n!="object"||n==null)return;n=n[o]}if(n==null)return}const s=t[t.length-1];if(typeof s=="number"){Array.isArray(n)&&n.splice(s,1);return}typeof n=="object"&&n!=null&&delete n[s]}async function me(e){if(!(!e.client||!e.connected)){e.configLoading=!0,e.lastError=null;try{const t=await e.client.request("config.get",{});Gl(e,t)}catch(t){e.lastError=String(t)}finally{e.configLoading=!1}}}async function fa(e){if(!(!e.client||!e.connected)&&!e.configSchemaLoading){e.configSchemaLoading=!0;try{const t=await e.client.request("config.schema",{});Vl(e,t)}catch(t){e.lastError=String(t)}finally{e.configSchemaLoading=!1}}}function Vl(e,t){e.configSchema=t.schema??null,e.configUiHints=t.uiHints??{},e.configSchemaVersion=t.version??null}function Gl(e,t){e.configSnapshot=t;const n=typeof t.raw=="string"?t.raw:t.config&&typeof t.config=="object"?Xe(t.config):e.configRaw;!e.configFormDirty||e.configFormMode==="raw"?e.configRaw=n:e.configForm?e.configRaw=Xe(e.configForm):e.configRaw=n,e.configValid=typeof t.valid=="boolean"?t.valid:null,e.configIssues=Array.isArray(t.issues)?t.issues:[],e.configFormDirty||(e.configForm=Oe(t.config??{}),e.configFormOriginal=Oe(t.config??{}))}async function cs(e){if(!(!e.client||!e.connected)){e.configSaving=!0,e.lastError=null;try{const t=e.configFormMode==="form"&&e.configForm?Xe(e.configForm):e.configRaw,n=e.configSnapshot?.hash;if(!n){e.lastError="Config hash missing; reload and retry.";return}await e.client.request("config.set",{raw:t,baseHash:n}),e.configFormDirty=!1,await me(e)}catch(t){e.lastError=String(t)}finally{e.configSaving=!1}}}async function Yl(e){if(!(!e.client||!e.connected)){e.configApplying=!0,e.lastError=null;try{const t=e.configFormMode==="form"&&e.configForm?Xe(e.configForm):e.configRaw,n=e.configSnapshot?.hash;if(!n){e.lastError="Config hash missing; reload and retry.";return}await e.client.request("config.apply",{raw:t,baseHash:n,sessionKey:e.applySessionKey}),e.configFormDirty=!1,await me(e)}catch(t){e.lastError=String(t)}finally{e.configApplying=!1}}}async function Ql(e){if(!(!e.client||!e.connected)){e.updateRunning=!0,e.lastError=null;try{await e.client.request("update.run",{sessionKey:e.applySessionKey})}catch(t){e.lastError=String(t)}finally{e.updateRunning=!1}}}function Ot(e,t,n){const s=Oe(e.configForm??e.configSnapshot?.config??{});ua(s,t,n),e.configForm=s,e.configFormDirty=!0,e.configFormMode==="form"&&(e.configRaw=Xe(s))}function Xi(e,t){const n=Oe(e.configForm??e.configSnapshot?.config??{});pa(n,t),e.configForm=n,e.configFormDirty=!0,e.configFormMode==="form"&&(e.configRaw=Xe(n))}async function _t(e){if(!(!e.client||!e.connected))try{const t=await e.client.request("cron.status",{});e.cronStatus=t}catch(t){e.cronError=String(t)}}async function ln(e){if(!(!e.client||!e.connected)&&!e.cronLoading){e.cronLoading=!0,e.cronError=null;try{const t=await e.client.request("cron.list",{includeDisabled:!0});e.cronJobs=Array.isArray(t.jobs)?t.jobs:[]}catch(t){e.cronError=String(t)}finally{e.cronLoading=!1}}}function Jl(e){if(e.scheduleKind==="at"){const n=Date.parse(e.scheduleAt);if(!Number.isFinite(n))throw new Error("Invalid run time.");return{kind:"at",atMs:n}}if(e.scheduleKind==="every"){const n=Yt(e.everyAmount,0);if(n<=0)throw new Error("Invalid interval amount.");const s=e.everyUnit;return{kind:"every",everyMs:n*(s==="minutes"?6e4:s==="hours"?36e5:864e5)}}const t=e.cronExpr.trim();if(!t)throw new Error("Cron expression required.");return{kind:"cron",expr:t,tz:e.cronTz.trim()||void 0}}function Zl(e){if(e.payloadKind==="systemEvent"){const i=e.payloadText.trim();if(!i)throw new Error("System event text required.");return{kind:"systemEvent",text:i}}const t=e.payloadText.trim();if(!t)throw new Error("Agent message required.");const n={kind:"agentTurn",message:t};e.deliver&&(n.deliver=!0),e.channel&&(n.channel=e.channel),e.to.trim()&&(n.to=e.to.trim());const s=Yt(e.timeoutSeconds,0);return s>0&&(n.timeoutSeconds=s),n}async function Xl(e){if(!(!e.client||!e.connected||e.cronBusy)){e.cronBusy=!0,e.cronError=null;try{const t=Jl(e.cronForm),n=Zl(e.cronForm),s=e.cronForm.agentId.trim(),i={name:e.cronForm.name.trim(),description:e.cronForm.description.trim()||void 0,agentId:s||void 0,enabled:e.cronForm.enabled,schedule:t,sessionTarget:e.cronForm.sessionTarget,wakeMode:e.cronForm.wakeMode,payload:n,isolation:e.cronForm.postToMainPrefix.trim()&&e.cronForm.sessionTarget==="isolated"?{postToMainPrefix:e.cronForm.postToMainPrefix.trim()}:void 0};if(!i.name)throw new Error("Name required.");await e.client.request("cron.add",i),e.cronForm={...e.cronForm,name:"",description:"",payloadText:""},await ln(e),await _t(e)}catch(t){e.cronError=String(t)}finally{e.cronBusy=!1}}}async function ec(e,t,n){if(!(!e.client||!e.connected||e.cronBusy)){e.cronBusy=!0,e.cronError=null;try{await e.client.request("cron.update",{id:t.id,patch:{enabled:n}}),await ln(e),await _t(e)}catch(s){e.cronError=String(s)}finally{e.cronBusy=!1}}}async function tc(e,t){if(!(!e.client||!e.connected||e.cronBusy)){e.cronBusy=!0,e.cronError=null;try{await e.client.request("cron.run",{id:t.id,mode:"force"}),await ha(e,t.id)}catch(n){e.cronError=String(n)}finally{e.cronBusy=!1}}}async function nc(e,t){if(!(!e.client||!e.connected||e.cronBusy)){e.cronBusy=!0,e.cronError=null;try{await e.client.request("cron.remove",{id:t.id}),e.cronRunsJobId===t.id&&(e.cronRunsJobId=null,e.cronRuns=[]),await ln(e),await _t(e)}catch(n){e.cronError=String(n)}finally{e.cronBusy=!1}}}async function ha(e,t){if(!(!e.client||!e.connected))try{const n=await e.client.request("cron.runs",{id:t,limit:50});e.cronRunsJobId=t,e.cronRuns=Array.isArray(n.entries)?n.entries:[]}catch(n){e.cronError=String(n)}}async function oe(e,t){if(!(!e.client||!e.connected)&&!e.channelsLoading){e.channelsLoading=!0,e.channelsError=null;try{const n=await e.client.request("channels.status",{probe:t,timeoutMs:8e3});e.channelsSnapshot=n,e.channelsLastSuccess=Date.now()}catch(n){e.channelsError=String(n)}finally{e.channelsLoading=!1}}}async function sc(e,t){if(!(!e.client||!e.connected||e.whatsappBusy)){e.whatsappBusy=!0;try{const n=await e.client.request("web.login.start",{force:t,timeoutMs:3e4});e.whatsappLoginMessage=n.message??null,e.whatsappLoginQrDataUrl=n.qrDataUrl??null,e.whatsappLoginConnected=null}catch(n){e.whatsappLoginMessage=String(n),e.whatsappLoginQrDataUrl=null,e.whatsappLoginConnected=null}finally{e.whatsappBusy=!1}}}async function ic(e){if(!(!e.client||!e.connected||e.whatsappBusy)){e.whatsappBusy=!0;try{const t=await e.client.request("web.login.wait",{timeoutMs:12e4});e.whatsappLoginMessage=t.message??null,e.whatsappLoginConnected=t.connected??null,t.connected&&(e.whatsappLoginQrDataUrl=null)}catch(t){e.whatsappLoginMessage=String(t),e.whatsappLoginConnected=null}finally{e.whatsappBusy=!1}}}async function oc(e){if(!(!e.client||!e.connected||e.whatsappBusy)){e.whatsappBusy=!0;try{await e.client.request("channels.logout",{channel:"whatsapp"}),e.whatsappLoginMessage="Logged out.",e.whatsappLoginQrDataUrl=null,e.whatsappLoginConnected=null}catch(t){e.whatsappLoginMessage=String(t)}finally{e.whatsappBusy=!1}}}async function cn(e){if(!(!e.client||!e.connected)&&!e.debugLoading){e.debugLoading=!0;try{const[t,n,s,i]=await Promise.all([e.client.request("status",{}),e.client.request("health",{}),e.client.request("models.list",{}),e.client.request("last-heartbeat",{})]);e.debugStatus=t,e.debugHealth=n;const o=s;e.debugModels=Array.isArray(o?.models)?o?.models:[],e.debugHeartbeat=i}catch(t){e.debugCallError=String(t)}finally{e.debugLoading=!1}}}async function ac(e){if(!(!e.client||!e.connected)){e.debugCallError=null,e.debugCallResult=null;try{const t=e.debugCallParams.trim()?JSON.parse(e.debugCallParams):{},n=await e.client.request(e.debugCallMethod.trim(),t);e.debugCallResult=JSON.stringify(n,null,2)}catch(t){e.debugCallError=String(t)}}}const rc=2e3,lc=new Set(["trace","debug","info","warn","error","fatal"]);function cc(e){if(typeof e!="string")return null;const t=e.trim();if(!t.startsWith("{")||!t.endsWith("}"))return null;try{const n=JSON.parse(t);return!n||typeof n!="object"?null:n}catch{return null}}function dc(e){if(typeof e!="string")return null;const t=e.toLowerCase();return lc.has(t)?t:null}function uc(e){if(!e.trim())return{raw:e,message:e};try{const t=JSON.parse(e),n=t&&typeof t._meta=="object"&&t._meta!==null?t._meta:null,s=typeof t.time=="string"?t.time:typeof n?.date=="string"?n?.date:null,i=dc(n?.logLevelName??n?.level),o=typeof t[0]=="string"?t[0]:typeof n?.name=="string"?n?.name:null,a=cc(o);let l=null;a&&(typeof a.subsystem=="string"?l=a.subsystem:typeof a.module=="string"&&(l=a.module)),!l&&o&&o.length<120&&(l=o);let r=null;return typeof t[1]=="string"?r=t[1]:!a&&typeof t[0]=="string"?r=t[0]:typeof t.message=="string"&&(r=t.message),{raw:e,time:s,level:i,subsystem:l,message:r??e,meta:n??void 0}}catch{return{raw:e,message:e}}}async function Ds(e,t){if(!(!e.client||!e.connected)&&!(e.logsLoading&&!t?.quiet)){t?.quiet||(e.logsLoading=!0),e.logsError=null;try{const s=await e.client.request("logs.tail",{cursor:t?.reset?void 0:e.logsCursor??void 0,limit:e.logsLimit,maxBytes:e.logsMaxBytes}),o=(Array.isArray(s.lines)?s.lines.filter(l=>typeof l=="string"):[]).map(uc),a=!!(t?.reset||s.reset||e.logsCursor==null);e.logsEntries=a?o:[...e.logsEntries,...o].slice(-rc),typeof s.cursor=="number"&&(e.logsCursor=s.cursor),typeof s.file=="string"&&(e.logsFile=s.file),e.logsTruncated=!!s.truncated,e.logsLastFetchAt=Date.now()}catch(n){e.logsError=String(n)}finally{t?.quiet||(e.logsLoading=!1)}}}const ga={p:0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffedn,n:0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn,h:8n,a:0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffecn,d:0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3n,Gx:0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51an,Gy:0x6666666666666666666666666666666666666666666666666666666666666658n},{p:W,n:qt,Gx:eo,Gy:to,a:Kn,d:Hn,h:pc}=ga,De=32,Bs=64,fc=(...e)=>{"captureStackTrace"in Error&&typeof Error.captureStackTrace=="function"&&Error.captureStackTrace(...e)},H=(e="")=>{const t=new Error(e);throw fc(t,H),t},hc=e=>typeof e=="bigint",gc=e=>typeof e=="string",vc=e=>e instanceof Uint8Array||ArrayBuffer.isView(e)&&e.constructor.name==="Uint8Array",Ae=(e,t,n="")=>{const s=vc(e),i=e?.length,o=t!==void 0;if(!s||o&&i!==t){const a=n&&`"${n}" `,l=o?` of length ${t}`:"",r=s?`length=${i}`:`type=${typeof e}`;H(a+"expected Uint8Array"+l+", got "+r)}return e},dn=e=>new Uint8Array(e),va=e=>Uint8Array.from(e),ma=(e,t)=>e.toString(16).padStart(t,"0"),ba=e=>Array.from(Ae(e)).map(t=>ma(t,2)).join(""),ge={_0:48,_9:57,A:65,F:70,a:97,f:102},no=e=>{if(e>=ge._0&&e<=ge._9)return e-ge._0;if(e>=ge.A&&e<=ge.F)return e-(ge.A-10);if(e>=ge.a&&e<=ge.f)return e-(ge.a-10)},ya=e=>{const t="hex invalid";if(!gc(e))return H(t);const n=e.length,s=n/2;if(n%2)return H(t);const i=dn(s);for(let o=0,a=0;o<s;o++,a+=2){const l=no(e.charCodeAt(a)),r=no(e.charCodeAt(a+1));if(l===void 0||r===void 0)return H(t);i[o]=l*16+r}return i},wa=()=>globalThis?.crypto,mc=()=>wa()?.subtle??H("crypto.subtle must be defined, consider polyfill"),At=(...e)=>{const t=dn(e.reduce((s,i)=>s+Ae(i).length,0));let n=0;return e.forEach(s=>{t.set(s,n),n+=s.length}),t},bc=(e=De)=>wa().getRandomValues(dn(e)),Qt=BigInt,Re=(e,t,n,s="bad number: out of range")=>hc(e)&&t<=e&&e<n?e:H(s),S=(e,t=W)=>{const n=e%t;return n>=0n?n:t+n},$a=e=>S(e,qt),yc=(e,t)=>{(e===0n||t<=0n)&&H("no inverse n="+e+" mod="+t);let n=S(e,t),s=t,i=0n,o=1n;for(;n!==0n;){const a=s/n,l=s%n,r=i-o*a;s=n,n=l,i=o,o=r}return s===1n?S(i,t):H("no inverse")},wc=e=>{const t=Sa[e];return typeof t!="function"&&H("hashes."+e+" not set"),t},zn=e=>e instanceof X?e:H("Point expected"),ds=2n**256n;class X{static BASE;static ZERO;X;Y;Z;T;constructor(t,n,s,i){const o=ds;this.X=Re(t,0n,o),this.Y=Re(n,0n,o),this.Z=Re(s,1n,o),this.T=Re(i,0n,o),Object.freeze(this)}static CURVE(){return ga}static fromAffine(t){return new X(t.x,t.y,1n,S(t.x*t.y))}static fromBytes(t,n=!1){const s=Hn,i=va(Ae(t,De)),o=t[31];i[31]=o&-129;const a=xa(i);Re(a,0n,n?ds:W);const r=S(a*a),p=S(r-1n),d=S(s*r+1n);let{isValid:u,value:h}=kc(p,d);u||H("bad point: y not sqrt");const v=(h&1n)===1n,w=(o&128)!==0;return!n&&h===0n&&w&&H("bad point: x==0, isLastByteOdd"),w!==v&&(h=S(-h)),new X(h,a,1n,S(h*a))}static fromHex(t,n){return X.fromBytes(ya(t),n)}get x(){return this.toAffine().x}get y(){return this.toAffine().y}assertValidity(){const t=Kn,n=Hn,s=this;if(s.is0())return H("bad point: ZERO");const{X:i,Y:o,Z:a,T:l}=s,r=S(i*i),p=S(o*o),d=S(a*a),u=S(d*d),h=S(r*t),v=S(d*S(h+p)),w=S(u+S(n*S(r*p)));if(v!==w)return H("bad point: equation left != right (1)");const $=S(i*o),x=S(a*l);return $!==x?H("bad point: equation left != right (2)"):this}equals(t){const{X:n,Y:s,Z:i}=this,{X:o,Y:a,Z:l}=zn(t),r=S(n*l),p=S(o*i),d=S(s*l),u=S(a*i);return r===p&&d===u}is0(){return this.equals(Ye)}negate(){return new X(S(-this.X),this.Y,this.Z,S(-this.T))}double(){const{X:t,Y:n,Z:s}=this,i=Kn,o=S(t*t),a=S(n*n),l=S(2n*S(s*s)),r=S(i*o),p=t+n,d=S(S(p*p)-o-a),u=r+a,h=u-l,v=r-a,w=S(d*h),$=S(u*v),x=S(d*v),C=S(h*u);return new X(w,$,C,x)}add(t){const{X:n,Y:s,Z:i,T:o}=this,{X:a,Y:l,Z:r,T:p}=zn(t),d=Kn,u=Hn,h=S(n*a),v=S(s*l),w=S(o*u*p),$=S(i*r),x=S((n+s)*(a+l)-h-v),C=S($-w),I=S($+w),R=S(v-d*h),E=S(x*C),A=S(I*R),B=S(x*R),ue=S(C*I);return new X(E,A,ue,B)}subtract(t){return this.add(zn(t).negate())}multiply(t,n=!0){if(!n&&(t===0n||this.is0()))return Ye;if(Re(t,1n,qt),t===1n)return this;if(this.equals(Be))return Mc(t).p;let s=Ye,i=Be;for(let o=this;t>0n;o=o.double(),t>>=1n)t&1n?s=s.add(o):n&&(i=i.add(o));return s}multiplyUnsafe(t){return this.multiply(t,!1)}toAffine(){const{X:t,Y:n,Z:s}=this;if(this.equals(Ye))return{x:0n,y:1n};const i=yc(s,W);S(s*i)!==1n&&H("invalid inverse");const o=S(t*i),a=S(n*i);return{x:o,y:a}}toBytes(){const{x:t,y:n}=this.assertValidity().toAffine(),s=ka(n);return s[31]|=t&1n?128:0,s}toHex(){return ba(this.toBytes())}clearCofactor(){return this.multiply(Qt(pc),!1)}isSmallOrder(){return this.clearCofactor().is0()}isTorsionFree(){let t=this.multiply(qt/2n,!1).double();return qt%2n&&(t=t.add(this)),t.is0()}}const Be=new X(eo,to,1n,S(eo*to)),Ye=new X(0n,1n,1n,0n);X.BASE=Be;X.ZERO=Ye;const ka=e=>ya(ma(Re(e,0n,ds),Bs)).reverse(),xa=e=>Qt("0x"+ba(va(Ae(e)).reverse())),le=(e,t)=>{let n=e;for(;t-- >0n;)n*=n,n%=W;return n},$c=e=>{const n=e*e%W*e%W,s=le(n,2n)*n%W,i=le(s,1n)*e%W,o=le(i,5n)*i%W,a=le(o,10n)*o%W,l=le(a,20n)*a%W,r=le(l,40n)*l%W,p=le(r,80n)*r%W,d=le(p,80n)*r%W,u=le(d,10n)*o%W;return{pow_p_5_8:le(u,2n)*e%W,b2:n}},so=0x2b8324804fc1df0b2b4d00993dfbd7a72f431806ad2fe478c4ee1b274a0ea0b0n,kc=(e,t)=>{const n=S(t*t*t),s=S(n*n*t),i=$c(e*s).pow_p_5_8;let o=S(e*n*i);const a=S(t*o*o),l=o,r=S(o*so),p=a===e,d=a===S(-e),u=a===S(-e*so);return p&&(o=l),(d||u)&&(o=r),(S(o)&1n)===1n&&(o=S(-o)),{isValid:p||d,value:o}},us=e=>$a(xa(e)),Fs=(...e)=>Sa.sha512Async(At(...e)),xc=(...e)=>wc("sha512")(At(...e)),Aa=e=>{const t=e.slice(0,De);t[0]&=248,t[31]&=127,t[31]|=64;const n=e.slice(De,Bs),s=us(t),i=Be.multiply(s),o=i.toBytes();return{head:t,prefix:n,scalar:s,point:i,pointBytes:o}},Us=e=>Fs(Ae(e,De)).then(Aa),Ac=e=>Aa(xc(Ae(e,De))),Sc=e=>Us(e).then(t=>t.pointBytes),_c=e=>Fs(e.hashable).then(e.finish),Tc=(e,t,n)=>{const{pointBytes:s,scalar:i}=e,o=us(t),a=Be.multiply(o).toBytes();return{hashable:At(a,s,n),finish:p=>{const d=$a(o+us(p)*i);return Ae(At(a,ka(d)),Bs)}}},Cc=async(e,t)=>{const n=Ae(e),s=await Us(t),i=await Fs(s.prefix,n);return _c(Tc(s,i,n))},Sa={sha512Async:async e=>{const t=mc(),n=At(e);return dn(await t.digest("SHA-512",n.buffer))},sha512:void 0},Ec=(e=bc(De))=>e,Ic={getExtendedPublicKeyAsync:Us,getExtendedPublicKey:Ac,randomSecretKey:Ec},Jt=8,Lc=256,_a=Math.ceil(Lc/Jt)+1,ps=2**(Jt-1),Rc=()=>{const e=[];let t=Be,n=t;for(let s=0;s<_a;s++){n=t,e.push(n);for(let i=1;i<ps;i++)n=n.add(t),e.push(n);t=n.double()}return e};let io;const oo=(e,t)=>{const n=t.negate();return e?n:t},Mc=e=>{const t=io||(io=Rc());let n=Ye,s=Be;const i=2**Jt,o=i,a=Qt(i-1),l=Qt(Jt);for(let r=0;r<_a;r++){let p=Number(e&a);e>>=l,p>ps&&(p-=o,e+=1n);const d=r*ps,u=d,h=d+Math.abs(p)-1,v=r%2!==0,w=p<0;p===0?s=s.add(oo(v,t[u])):n=n.add(oo(w,t[h]))}return e!==0n&&H("invalid wnaf"),{p:n,f:s}},jn="clawdbot-device-identity-v1";function fs(e){let t="";for(const n of e)t+=String.fromCharCode(n);return btoa(t).replaceAll("+","-").replaceAll("/","_").replace(/=+$/g,"")}function Ta(e){const t=e.replaceAll("-","+").replaceAll("_","/"),n=t+"=".repeat((4-t.length%4)%4),s=atob(n),i=new Uint8Array(s.length);for(let o=0;o<s.length;o+=1)i[o]=s.charCodeAt(o);return i}function Pc(e){return Array.from(e).map(t=>t.toString(16).padStart(2,"0")).join("")}async function Ca(e){const t=await crypto.subtle.digest("SHA-256",e);return Pc(new Uint8Array(t))}async function Nc(){const e=Ic.randomSecretKey(),t=await Sc(e);return{deviceId:await Ca(t),publicKey:fs(t),privateKey:fs(e)}}async function Ks(){try{const n=localStorage.getItem(jn);if(n){const s=JSON.parse(n);if(s?.version===1&&typeof s.deviceId=="string"&&typeof s.publicKey=="string"&&typeof s.privateKey=="string"){const i=await Ca(Ta(s.publicKey));if(i!==s.deviceId){const o={...s,deviceId:i};return localStorage.setItem(jn,JSON.stringify(o)),{deviceId:i,publicKey:s.publicKey,privateKey:s.privateKey}}return{deviceId:s.deviceId,publicKey:s.publicKey,privateKey:s.privateKey}}}}catch{}const e=await Nc(),t={version:1,deviceId:e.deviceId,publicKey:e.publicKey,privateKey:e.privateKey,createdAtMs:Date.now()};return localStorage.setItem(jn,JSON.stringify(t)),e}async function Oc(e,t){const n=Ta(e),s=new TextEncoder().encode(t),i=await Cc(s,n);return fs(i)}const Ea="clawdbot.device.auth.v1";function Hs(e){return e.trim()}function Dc(e){if(!Array.isArray(e))return[];const t=new Set;for(const n of e){const s=n.trim();s&&t.add(s)}return[...t].sort()}function zs(){try{const e=window.localStorage.getItem(Ea);if(!e)return null;const t=JSON.parse(e);return!t||t.version!==1||!t.deviceId||typeof t.deviceId!="string"||!t.tokens||typeof t.tokens!="object"?null:t}catch{return null}}function Ia(e){try{window.localStorage.setItem(Ea,JSON.stringify(e))}catch{}}function Bc(e){const t=zs();if(!t||t.deviceId!==e.deviceId)return null;const n=Hs(e.role),s=t.tokens[n];return!s||typeof s.token!="string"?null:s}function La(e){const t=Hs(e.role),n={version:1,deviceId:e.deviceId,tokens:{}},s=zs();s&&s.deviceId===e.deviceId&&(n.tokens={...s.tokens});const i={token:e.token,role:t,scopes:Dc(e.scopes),updatedAtMs:Date.now()};return n.tokens[t]=i,Ia(n),i}function Ra(e){const t=zs();if(!t||t.deviceId!==e.deviceId)return;const n=Hs(e.role);if(!t.tokens[n])return;const s={...t,tokens:{...t.tokens}};delete s.tokens[n],Ia(s)}async function Se(e,t){if(!(!e.client||!e.connected)&&!e.devicesLoading){e.devicesLoading=!0,t?.quiet||(e.devicesError=null);try{const n=await e.client.request("device.pair.list",{});e.devicesList={pending:Array.isArray(n?.pending)?n.pending:[],paired:Array.isArray(n?.paired)?n.paired:[]}}catch(n){t?.quiet||(e.devicesError=String(n))}finally{e.devicesLoading=!1}}}async function Fc(e,t){if(!(!e.client||!e.connected))try{await e.client.request("device.pair.approve",{requestId:t}),await Se(e)}catch(n){e.devicesError=String(n)}}async function Uc(e,t){if(!(!e.client||!e.connected||!window.confirm("Reject this device pairing request?")))try{await e.client.request("device.pair.reject",{requestId:t}),await Se(e)}catch(s){e.devicesError=String(s)}}async function Kc(e,t){if(!(!e.client||!e.connected))try{const n=await e.client.request("device.token.rotate",t);if(n?.token){const s=await Ks(),i=n.role??t.role;(n.deviceId===s.deviceId||t.deviceId===s.deviceId)&&La({deviceId:s.deviceId,role:i,token:n.token,scopes:n.scopes??t.scopes??[]}),window.prompt("New device token (copy and store securely):",n.token)}await Se(e)}catch(n){e.devicesError=String(n)}}async function Hc(e,t){if(!(!e.client||!e.connected||!window.confirm(`Revoke token for ${t.deviceId} (${t.role})?`)))try{await e.client.request("device.token.revoke",t);const s=await Ks();t.deviceId===s.deviceId&&Ra({deviceId:s.deviceId,role:t.role}),await Se(e)}catch(s){e.devicesError=String(s)}}async function un(e,t){if(!(!e.client||!e.connected)&&!e.nodesLoading){e.nodesLoading=!0,t?.quiet||(e.lastError=null);try{const n=await e.client.request("node.list",{});e.nodes=Array.isArray(n.nodes)?n.nodes:[]}catch(n){t?.quiet||(e.lastError=String(n))}finally{e.nodesLoading=!1}}}function zc(e){if(!e||e.kind==="gateway")return{method:"exec.approvals.get",params:{}};const t=e.nodeId.trim();return t?{method:"exec.approvals.node.get",params:{nodeId:t}}:null}function jc(e,t){if(!e||e.kind==="gateway")return{method:"exec.approvals.set",params:t};const n=e.nodeId.trim();return n?{method:"exec.approvals.node.set",params:{...t,nodeId:n}}:null}async function js(e,t){if(!(!e.client||!e.connected)&&!e.execApprovalsLoading){e.execApprovalsLoading=!0,e.lastError=null;try{const n=zc(t);if(!n){e.lastError="Select a node before loading exec approvals.";return}const s=await e.client.request(n.method,n.params);qc(e,s)}catch(n){e.lastError=String(n)}finally{e.execApprovalsLoading=!1}}}function qc(e,t){e.execApprovalsSnapshot=t,e.execApprovalsDirty||(e.execApprovalsForm=Oe(t.file??{}))}async function Wc(e,t){if(!(!e.client||!e.connected)){e.execApprovalsSaving=!0,e.lastError=null;try{const n=e.execApprovalsSnapshot?.hash;if(!n){e.lastError="Exec approvals hash missing; reload and retry.";return}const s=e.execApprovalsForm??e.execApprovalsSnapshot?.file??{},i=jc(t,{file:s,baseHash:n});if(!i){e.lastError="Select a node before saving exec approvals.";return}await e.client.request(i.method,i.params),e.execApprovalsDirty=!1,await js(e,t)}catch(n){e.lastError=String(n)}finally{e.execApprovalsSaving=!1}}}function Vc(e,t,n){const s=Oe(e.execApprovalsForm??e.execApprovalsSnapshot?.file??{});ua(s,t,n),e.execApprovalsForm=s,e.execApprovalsDirty=!0}function Gc(e,t){const n=Oe(e.execApprovalsForm??e.execApprovalsSnapshot?.file??{});pa(n,t),e.execApprovalsForm=n,e.execApprovalsDirty=!0}async function qs(e){if(!(!e.client||!e.connected)&&!e.presenceLoading){e.presenceLoading=!0,e.presenceError=null,e.presenceStatus=null;try{const t=await e.client.request("system-presence",{});Array.isArray(t)?(e.presenceEntries=t,e.presenceStatus=t.length===0?"No instances yet.":null):(e.presenceEntries=[],e.presenceStatus="No presence payload.")}catch(t){e.presenceError=String(t)}finally{e.presenceLoading=!1}}}function et(e,t,n){if(!t.trim())return;const s={...e.skillMessages};n?s[t]=n:delete s[t],e.skillMessages=s}function pn(e){return e instanceof Error?e.message:String(e)}async function Tt(e,t){if(t?.clearMessages&&Object.keys(e.skillMessages).length>0&&(e.skillMessages={}),!(!e.client||!e.connected)&&!e.skillsLoading){e.skillsLoading=!0,e.skillsError=null;try{const n=await e.client.request("skills.status",{});n&&(e.skillsReport=n)}catch(n){e.skillsError=pn(n)}finally{e.skillsLoading=!1}}}function Yc(e,t,n){e.skillEdits={...e.skillEdits,[t]:n}}async function Qc(e,t,n){if(!(!e.client||!e.connected)){e.skillsBusyKey=t,e.skillsError=null;try{await e.client.request("skills.update",{skillKey:t,enabled:n}),await Tt(e),et(e,t,{kind:"success",message:n?"Skill enabled":"Skill disabled"})}catch(s){const i=pn(s);e.skillsError=i,et(e,t,{kind:"error",message:i})}finally{e.skillsBusyKey=null}}}async function Jc(e,t){if(!(!e.client||!e.connected)){e.skillsBusyKey=t,e.skillsError=null;try{const n=e.skillEdits[t]??"";await e.client.request("skills.update",{skillKey:t,apiKey:n}),await Tt(e),et(e,t,{kind:"success",message:"API key saved"})}catch(n){const s=pn(n);e.skillsError=s,et(e,t,{kind:"error",message:s})}finally{e.skillsBusyKey=null}}}async function Zc(e,t,n,s){if(!(!e.client||!e.connected)){e.skillsBusyKey=t,e.skillsError=null;try{const i=await e.client.request("skills.install",{name:n,installId:s,timeoutMs:12e4});await Tt(e),et(e,t,{kind:"success",message:i?.message??"Installed"})}catch(i){const o=pn(i);e.skillsError=o,et(e,t,{kind:"error",message:o})}finally{e.skillsBusyKey=null}}}function Xc(){return typeof window>"u"||typeof window.matchMedia!="function"||window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}function Ws(e){return e==="system"?Xc():e}const Dt=e=>Number.isNaN(e)?.5:e<=0?0:e>=1?1:e,ed=()=>typeof window>"u"||typeof window.matchMedia!="function"?!1:window.matchMedia("(prefers-reduced-motion: reduce)").matches??!1,Bt=e=>{e.classList.remove("theme-transition"),e.style.removeProperty("--theme-switch-x"),e.style.removeProperty("--theme-switch-y")},td=({nextTheme:e,applyTheme:t,context:n,currentTheme:s})=>{if(s===e)return;const i=globalThis.document??null;if(!i){t();return}const o=i.documentElement,a=i,l=ed();if(!!a.startViewTransition&&!l){let p=.5,d=.5;if(n?.pointerClientX!==void 0&&n?.pointerClientY!==void 0&&typeof window<"u")p=Dt(n.pointerClientX/window.innerWidth),d=Dt(n.pointerClientY/window.innerHeight);else if(n?.element){const u=n.element.getBoundingClientRect();u.width>0&&u.height>0&&typeof window<"u"&&(p=Dt((u.left+u.width/2)/window.innerWidth),d=Dt((u.top+u.height/2)/window.innerHeight))}o.style.setProperty("--theme-switch-x",`${p*100}%`),o.style.setProperty("--theme-switch-y",`${d*100}%`),o.classList.add("theme-transition");try{const u=a.startViewTransition?.(()=>{t()});u?.finished?u.finished.finally(()=>Bt(o)):Bt(o)}catch{Bt(o),t()}return}t(),Bt(o)};function nd(e){e.nodesPollInterval==null&&(e.nodesPollInterval=window.setInterval(()=>{un(e,{quiet:!0})},5e3))}function sd(e){e.nodesPollInterval!=null&&(clearInterval(e.nodesPollInterval),e.nodesPollInterval=null)}function Vs(e){e.logsPollInterval==null&&(e.logsPollInterval=window.setInterval(()=>{e.tab==="logs"&&Ds(e,{quiet:!0})},2e3))}function Gs(e){e.logsPollInterval!=null&&(clearInterval(e.logsPollInterval),e.logsPollInterval=null)}function Ys(e){e.debugPollInterval==null&&(e.debugPollInterval=window.setInterval(()=>{e.tab==="debug"&&cn(e)},3e3))}function Qs(e){e.debugPollInterval!=null&&(clearInterval(e.debugPollInterval),e.debugPollInterval=null)}function $e(e,t){const n={...t,lastActiveSessionKey:t.lastActiveSessionKey?.trim()||t.sessionKey.trim()||"main"};e.settings=n,gl(n),t.theme!==e.theme&&(e.theme=t.theme,fn(e,Ws(t.theme))),e.applySessionKey=e.settings.lastActiveSessionKey}function Ma(e,t){const n=t.trim();n&&e.settings.lastActiveSessionKey!==n&&$e(e,{...e.settings,lastActiveSessionKey:n})}function id(e){if(!window.location.search)return;const t=new URLSearchParams(window.location.search),n=t.get("token"),s=t.get("password"),i=t.get("session"),o=t.get("gatewayUrl");let a=!1;if(n!=null){const r=n.trim();r&&r!==e.settings.token&&$e(e,{...e.settings,token:r}),t.delete("token"),a=!0}if(s!=null){const r=s.trim();r&&(e.password=r),t.delete("password"),a=!0}if(i!=null){const r=i.trim();r&&(e.sessionKey=r,$e(e,{...e.settings,sessionKey:r,lastActiveSessionKey:r}))}if(o!=null){const r=o.trim();r&&r!==e.settings.gatewayUrl&&$e(e,{...e.settings,gatewayUrl:r}),t.delete("gatewayUrl"),a=!0}if(!a)return;const l=new URL(window.location.href);l.search=t.toString(),window.history.replaceState({},"",l.toString())}function od(e,t){e.tab!==t&&(e.tab=t),t==="chat"&&(e.chatHasAutoScrolled=!1),t==="logs"?Vs(e):Gs(e),t==="debug"?Ys(e):Qs(e),Js(e),Na(e,t,!1)}function ad(e,t,n){td({nextTheme:t,applyTheme:()=>{e.theme=t,$e(e,{...e.settings,theme:t}),fn(e,Ws(t))},context:n,currentTheme:e.theme})}async function Js(e){e.tab==="overview"&&await Oa(e),e.tab==="channels"&&await hd(e),e.tab==="instances"&&await qs(e),e.tab==="sessions"&&await nt(e),e.tab==="cron"&&await Zs(e),e.tab==="skills"&&await Tt(e),e.tab==="nodes"&&(await un(e),await Se(e),await me(e),await js(e)),e.tab==="chat"&&(await yd(e),rn(e,!e.chatHasAutoScrolled)),e.tab==="config"&&(await fa(e),await me(e)),e.tab==="debug"&&(await cn(e),e.eventLog=e.eventLogBuffer),e.tab==="logs"&&(e.logsAtBottom=!0,await Ds(e,{reset:!0}),da(e,!0))}function rd(){if(typeof window>"u")return"";const e=window.__CLAWDBOT_CONTROL_UI_BASE_PATH__;return typeof e=="string"&&e.trim()?an(e):ml(window.location.pathname)}function ld(e){e.theme=e.settings.theme??"system",fn(e,Ws(e.theme))}function fn(e,t){if(e.themeResolved=t,typeof document>"u")return;const n=document.documentElement;n.dataset.theme=t,n.style.colorScheme=t}function cd(e){if(typeof window>"u"||typeof window.matchMedia!="function")return;if(e.themeMedia=window.matchMedia("(prefers-color-scheme: dark)"),e.themeMediaHandler=n=>{e.theme==="system"&&fn(e,n.matches?"dark":"light")},typeof e.themeMedia.addEventListener=="function"){e.themeMedia.addEventListener("change",e.themeMediaHandler);return}e.themeMedia.addListener(e.themeMediaHandler)}function dd(e){if(!e.themeMedia||!e.themeMediaHandler)return;if(typeof e.themeMedia.removeEventListener=="function"){e.themeMedia.removeEventListener("change",e.themeMediaHandler);return}e.themeMedia.removeListener(e.themeMediaHandler),e.themeMedia=null,e.themeMediaHandler=null}function ud(e,t){if(typeof window>"u")return;const n=aa(window.location.pathname,e.basePath)??"chat";Pa(e,n),Na(e,n,t)}function pd(e){if(typeof window>"u")return;const t=aa(window.location.pathname,e.basePath);if(!t)return;const s=new URL(window.location.href).searchParams.get("session")?.trim();s&&(e.sessionKey=s,$e(e,{...e.settings,sessionKey:s,lastActiveSessionKey:s})),Pa(e,t)}function Pa(e,t){e.tab!==t&&(e.tab=t),t==="chat"&&(e.chatHasAutoScrolled=!1),t==="logs"?Vs(e):Gs(e),t==="debug"?Ys(e):Qs(e),e.connected&&Js(e)}function Na(e,t,n){if(typeof window>"u")return;const s=kt(Ps(t,e.basePath)),i=kt(window.location.pathname),o=new URL(window.location.href);t==="chat"&&e.sessionKey?o.searchParams.set("session",e.sessionKey):o.searchParams.delete("session"),i!==s&&(o.pathname=s),n?window.history.replaceState({},"",o.toString()):window.history.pushState({},"",o.toString())}function fd(e,t,n){if(typeof window>"u")return;const s=new URL(window.location.href);s.searchParams.set("session",t),window.history.replaceState({},"",s.toString())}async function Oa(e){await Promise.all([oe(e,!1),qs(e),nt(e),_t(e),cn(e)])}async function hd(e){await Promise.all([oe(e,!0),fa(e),me(e)])}async function Zs(e){await Promise.all([oe(e,!1),_t(e),ln(e)])}function Da(e){return e.chatSending||!!e.chatRunId}function gd(e){const t=e.trim();if(!t)return!1;const n=t.toLowerCase();return n==="/stop"?!0:n==="stop"||n==="esc"||n==="abort"||n==="wait"||n==="exit"}async function Ba(e){e.connected&&(e.chatMessage="",await Cl(e))}function vd(e,t){const n=t.trim();n&&(e.chatQueue=[...e.chatQueue,{id:Ns(),text:n,createdAt:Date.now()}])}async function Fa(e,t,n){Os(e);const s=await Tl(e,t);return!s&&n?.previousDraft!=null&&(e.chatMessage=n.previousDraft),s&&Ma(e,e.sessionKey),s&&n?.restoreDraft&&n.previousDraft?.trim()&&(e.chatMessage=n.previousDraft),rn(e),s&&!e.chatRunId&&Ua(e),s}async function Ua(e){if(!e.connected||Da(e))return;const[t,...n]=e.chatQueue;if(!t)return;e.chatQueue=n,await Fa(e,t.text)||(e.chatQueue=[t,...e.chatQueue])}function md(e,t){e.chatQueue=e.chatQueue.filter(n=>n.id!==t)}async function bd(e,t,n){if(!e.connected)return;const s=e.chatMessage,i=(t??e.chatMessage).trim();if(i){if(gd(i)){await Ba(e);return}if(t==null&&(e.chatMessage=""),Da(e)){vd(e,i);return}await Fa(e,i,{previousDraft:t==null?s:void 0,restoreDraft:!!(t&&n?.restoreDraft)})}}async function yd(e){await Promise.all([Ze(e),nt(e),hs(e)]),rn(e,!0)}const wd=Ua;function $d(e){const t=sa(e.sessionKey);return t?.agentId?t.agentId:e.hello?.snapshot?.sessionDefaults?.defaultAgentId?.trim()||"main"}function kd(e,t){const n=an(e),s=encodeURIComponent(t);return n?`${n}/avatar/${s}?meta=1`:`/avatar/${s}?meta=1`}async function hs(e){if(!e.connected){e.chatAvatarUrl=null;return}const t=$d(e);if(!t){e.chatAvatarUrl=null;return}e.chatAvatarUrl=null;const n=kd(e.basePath,t);try{const s=await fetch(n,{method:"GET"});if(!s.ok){e.chatAvatarUrl=null;return}const i=await s.json(),o=typeof i.avatarUrl=="string"?i.avatarUrl.trim():"";e.chatAvatarUrl=o||null}catch{e.chatAvatarUrl=null}}const Ka={CHILD:2},Ha=e=>(...t)=>({_$litDirective$:e,values:t});let za=class{constructor(t){}get _$AU(){return this._$AM._$AU}_$AT(t,n,s){this._$Ct=t,this._$AM=n,this._$Ci=s}_$AS(t,n){return this.update(t,n)}update(t,n){return this.render(...n)}};const{I:xd}=il,ao=e=>e,ro=()=>document.createComment(""),rt=(e,t,n)=>{const s=e._$AA.parentNode,i=t===void 0?e._$AB:t._$AA;if(n===void 0){const o=s.insertBefore(ro(),i),a=s.insertBefore(ro(),i);n=new xd(o,a,e,e.options)}else{const o=n._$AB.nextSibling,a=n._$AM,l=a!==e;if(l){let r;n._$AQ?.(e),n._$AM=e,n._$AP!==void 0&&(r=e._$AU)!==a._$AU&&n._$AP(r)}if(o!==i||l){let r=n._$AA;for(;r!==o;){const p=ao(r).nextSibling;ao(s).insertBefore(r,i),r=p}}}return n},Ie=(e,t,n=e)=>(e._$AI(t,n),e),Ad={},Sd=(e,t=Ad)=>e._$AH=t,_d=e=>e._$AH,qn=e=>{e._$AR(),e._$AA.remove()};const lo=(e,t,n)=>{const s=new Map;for(let i=t;i<=n;i++)s.set(e[i],i);return s},ja=Ha(class extends za{constructor(e){if(super(e),e.type!==Ka.CHILD)throw Error("repeat() can only be used in text expressions")}dt(e,t,n){let s;n===void 0?n=t:t!==void 0&&(s=t);const i=[],o=[];let a=0;for(const l of e)i[a]=s?s(l,a):a,o[a]=n(l,a),a++;return{values:o,keys:i}}render(e,t,n){return this.dt(e,t,n).values}update(e,[t,n,s]){const i=_d(e),{values:o,keys:a}=this.dt(t,n,s);if(!Array.isArray(i))return this.ut=a,o;const l=this.ut??=[],r=[];let p,d,u=0,h=i.length-1,v=0,w=o.length-1;for(;u<=h&&v<=w;)if(i[u]===null)u++;else if(i[h]===null)h--;else if(l[u]===a[v])r[v]=Ie(i[u],o[v]),u++,v++;else if(l[h]===a[w])r[w]=Ie(i[h],o[w]),h--,w--;else if(l[u]===a[w])r[w]=Ie(i[u],o[w]),rt(e,r[w+1],i[u]),u++,w--;else if(l[h]===a[v])r[v]=Ie(i[h],o[v]),rt(e,i[u],i[h]),h--,v++;else if(p===void 0&&(p=lo(a,v,w),d=lo(l,u,h)),p.has(l[u]))if(p.has(l[h])){const $=d.get(a[v]),x=$!==void 0?i[$]:null;if(x===null){const C=rt(e,i[u]);Ie(C,o[v]),r[v]=C}else r[v]=Ie(x,o[v]),rt(e,i[u],x),i[$]=null;v++}else qn(i[h]),h--;else qn(i[u]),u++;for(;v<=w;){const $=rt(e,r[w+1]);Ie($,o[v]),r[v++]=$}for(;u<=h;){const $=i[u++];$!==null&&qn($)}return this.ut=a,Sd(e,r),xe}});function qa(e){const t=e;let n=typeof t.role=="string"?t.role:"unknown";const s=typeof t.toolCallId=="string"||typeof t.tool_call_id=="string",i=t.content,o=Array.isArray(i)?i:null,a=Array.isArray(o)&&o.some(u=>{const v=String(u.type??"").toLowerCase();return v==="toolresult"||v==="tool_result"}),l=typeof t.toolName=="string"||typeof t.tool_name=="string";(s||a||l)&&(n="toolResult");let r=[];typeof t.content=="string"?r=[{type:"text",text:t.content}]:Array.isArray(t.content)?r=t.content.map(u=>({type:u.type||"text",text:u.text,name:u.name,args:u.args||u.arguments})):typeof t.text=="string"&&(r=[{type:"text",text:t.text}]);const p=typeof t.timestamp=="number"?t.timestamp:Date.now(),d=typeof t.id=="string"?t.id:void 0;return{role:n,content:r,timestamp:p,id:d}}function Xs(e){const t=e.toLowerCase();return e==="user"||e==="User"?e:e==="assistant"?"assistant":e==="system"?"system":t==="toolresult"||t==="tool_result"||t==="tool"||t==="function"?"tool":e}function Wa(e){const t=e,n=typeof t.role=="string"?t.role.toLowerCase():"";return n==="toolresult"||n==="tool_result"}class gs extends za{constructor(t){if(super(t),this.it=g,t.type!==Ka.CHILD)throw Error(this.constructor.directiveName+"() can only be used in child bindings")}render(t){if(t===g||t==null)return this._t=void 0,this.it=t;if(t===xe)return t;if(typeof t!="string")throw Error(this.constructor.directiveName+"() called with a non-string value");if(t===this.it)return this._t;this.it=t;const n=[t];return n.raw=n,this._t={_$litType$:this.constructor.resultType,strings:n,values:[]}}}gs.directiveName="unsafeHTML",gs.resultType=1;const vs=Ha(gs);const{entries:Va,setPrototypeOf:co,isFrozen:Td,getPrototypeOf:Cd,getOwnPropertyDescriptor:Ed}=Object;let{freeze:Q,seal:te,create:ms}=Object,{apply:bs,construct:ys}=typeof Reflect<"u"&&Reflect;Q||(Q=function(t){return t});te||(te=function(t){return t});bs||(bs=function(t,n){for(var s=arguments.length,i=new Array(s>2?s-2:0),o=2;o<s;o++)i[o-2]=arguments[o];return t.apply(n,i)});ys||(ys=function(t){for(var n=arguments.length,s=new Array(n>1?n-1:0),i=1;i<n;i++)s[i-1]=arguments[i];return new t(...s)});const Ft=J(Array.prototype.forEach),Id=J(Array.prototype.lastIndexOf),uo=J(Array.prototype.pop),lt=J(Array.prototype.push),Ld=J(Array.prototype.splice),Wt=J(String.prototype.toLowerCase),Wn=J(String.prototype.toString),Vn=J(String.prototype.match),ct=J(String.prototype.replace),Rd=J(String.prototype.indexOf),Md=J(String.prototype.trim),ne=J(Object.prototype.hasOwnProperty),G=J(RegExp.prototype.test),dt=Pd(TypeError);function J(e){return function(t){t instanceof RegExp&&(t.lastIndex=0);for(var n=arguments.length,s=new Array(n>1?n-1:0),i=1;i<n;i++)s[i-1]=arguments[i];return bs(e,t,s)}}function Pd(e){return function(){for(var t=arguments.length,n=new Array(t),s=0;s<t;s++)n[s]=arguments[s];return ys(e,n)}}function L(e,t){let n=arguments.length>2&&arguments[2]!==void 0?arguments[2]:Wt;co&&co(e,null);let s=t.length;for(;s--;){let i=t[s];if(typeof i=="string"){const o=n(i);o!==i&&(Td(t)||(t[s]=o),i=o)}e[i]=!0}return e}function Nd(e){for(let t=0;t<e.length;t++)ne(e,t)||(e[t]=null);return e}function ce(e){const t=ms(null);for(const[n,s]of Va(e))ne(e,n)&&(Array.isArray(s)?t[n]=Nd(s):s&&typeof s=="object"&&s.constructor===Object?t[n]=ce(s):t[n]=s);return t}function ut(e,t){for(;e!==null;){const s=Ed(e,t);if(s){if(s.get)return J(s.get);if(typeof s.value=="function")return J(s.value)}e=Cd(e)}function n(){return null}return n}const po=Q(["a","abbr","acronym","address","area","article","aside","audio","b","bdi","bdo","big","blink","blockquote","body","br","button","canvas","caption","center","cite","code","col","colgroup","content","data","datalist","dd","decorator","del","details","dfn","dialog","dir","div","dl","dt","element","em","fieldset","figcaption","figure","font","footer","form","h1","h2","h3","h4","h5","h6","head","header","hgroup","hr","html","i","img","input","ins","kbd","label","legend","li","main","map","mark","marquee","menu","menuitem","meter","nav","nobr","ol","optgroup","option","output","p","picture","pre","progress","q","rp","rt","ruby","s","samp","search","section","select","shadow","slot","small","source","spacer","span","strike","strong","style","sub","summary","sup","table","tbody","td","template","textarea","tfoot","th","thead","time","tr","track","tt","u","ul","var","video","wbr"]),Gn=Q(["svg","a","altglyph","altglyphdef","altglyphitem","animatecolor","animatemotion","animatetransform","circle","clippath","defs","desc","ellipse","enterkeyhint","exportparts","filter","font","g","glyph","glyphref","hkern","image","inputmode","line","lineargradient","marker","mask","metadata","mpath","part","path","pattern","polygon","polyline","radialgradient","rect","stop","style","switch","symbol","text","textpath","title","tref","tspan","view","vkern"]),Yn=Q(["feBlend","feColorMatrix","feComponentTransfer","feComposite","feConvolveMatrix","feDiffuseLighting","feDisplacementMap","feDistantLight","feDropShadow","feFlood","feFuncA","feFuncB","feFuncG","feFuncR","feGaussianBlur","feImage","feMerge","feMergeNode","feMorphology","feOffset","fePointLight","feSpecularLighting","feSpotLight","feTile","feTurbulence"]),Od=Q(["animate","color-profile","cursor","discard","font-face","font-face-format","font-face-name","font-face-src","font-face-uri","foreignobject","hatch","hatchpath","mesh","meshgradient","meshpatch","meshrow","missing-glyph","script","set","solidcolor","unknown","use"]),Qn=Q(["math","menclose","merror","mfenced","mfrac","mglyph","mi","mlabeledtr","mmultiscripts","mn","mo","mover","mpadded","mphantom","mroot","mrow","ms","mspace","msqrt","mstyle","msub","msup","msubsup","mtable","mtd","mtext","mtr","munder","munderover","mprescripts"]),Dd=Q(["maction","maligngroup","malignmark","mlongdiv","mscarries","mscarry","msgroup","mstack","msline","msrow","semantics","annotation","annotation-xml","mprescripts","none"]),fo=Q(["#text"]),ho=Q(["accept","action","align","alt","autocapitalize","autocomplete","autopictureinpicture","autoplay","background","bgcolor","border","capture","cellpadding","cellspacing","checked","cite","class","clear","color","cols","colspan","controls","controlslist","coords","crossorigin","datetime","decoding","default","dir","disabled","disablepictureinpicture","disableremoteplayback","download","draggable","enctype","enterkeyhint","exportparts","face","for","headers","height","hidden","high","href","hreflang","id","inert","inputmode","integrity","ismap","kind","label","lang","list","loading","loop","low","max","maxlength","media","method","min","minlength","multiple","muted","name","nonce","noshade","novalidate","nowrap","open","optimum","part","pattern","placeholder","playsinline","popover","popovertarget","popovertargetaction","poster","preload","pubdate","radiogroup","readonly","rel","required","rev","reversed","role","rows","rowspan","spellcheck","scope","selected","shape","size","sizes","slot","span","srclang","start","src","srcset","step","style","summary","tabindex","title","translate","type","usemap","valign","value","width","wrap","xmlns","slot"]),Jn=Q(["accent-height","accumulate","additive","alignment-baseline","amplitude","ascent","attributename","attributetype","azimuth","basefrequency","baseline-shift","begin","bias","by","class","clip","clippathunits","clip-path","clip-rule","color","color-interpolation","color-interpolation-filters","color-profile","color-rendering","cx","cy","d","dx","dy","diffuseconstant","direction","display","divisor","dur","edgemode","elevation","end","exponent","fill","fill-opacity","fill-rule","filter","filterunits","flood-color","flood-opacity","font-family","font-size","font-size-adjust","font-stretch","font-style","font-variant","font-weight","fx","fy","g1","g2","glyph-name","glyphref","gradientunits","gradienttransform","height","href","id","image-rendering","in","in2","intercept","k","k1","k2","k3","k4","kerning","keypoints","keysplines","keytimes","lang","lengthadjust","letter-spacing","kernelmatrix","kernelunitlength","lighting-color","local","marker-end","marker-mid","marker-start","markerheight","markerunits","markerwidth","maskcontentunits","maskunits","max","mask","mask-type","media","method","mode","min","name","numoctaves","offset","operator","opacity","order","orient","orientation","origin","overflow","paint-order","path","pathlength","patterncontentunits","patterntransform","patternunits","points","preservealpha","preserveaspectratio","primitiveunits","r","rx","ry","radius","refx","refy","repeatcount","repeatdur","restart","result","rotate","scale","seed","shape-rendering","slope","specularconstant","specularexponent","spreadmethod","startoffset","stddeviation","stitchtiles","stop-color","stop-opacity","stroke-dasharray","stroke-dashoffset","stroke-linecap","stroke-linejoin","stroke-miterlimit","stroke-opacity","stroke","stroke-width","style","surfacescale","systemlanguage","tabindex","tablevalues","targetx","targety","transform","transform-origin","text-anchor","text-decoration","text-rendering","textlength","type","u1","u2","unicode","values","viewbox","visibility","version","vert-adv-y","vert-origin-x","vert-origin-y","width","word-spacing","wrap","writing-mode","xchannelselector","ychannelselector","x","x1","x2","xmlns","y","y1","y2","z","zoomandpan"]),go=Q(["accent","accentunder","align","bevelled","close","columnsalign","columnlines","columnspan","denomalign","depth","dir","display","displaystyle","encoding","fence","frame","height","href","id","largeop","length","linethickness","lspace","lquote","mathbackground","mathcolor","mathsize","mathvariant","maxsize","minsize","movablelimits","notation","numalign","open","rowalign","rowlines","rowspacing","rowspan","rspace","rquote","scriptlevel","scriptminsize","scriptsizemultiplier","selection","separator","separators","stretchy","subscriptshift","supscriptshift","symmetric","voffset","width","xmlns"]),Ut=Q(["xlink:href","xml:id","xlink:title","xml:space","xmlns:xlink"]),Bd=te(/\{\{[\w\W]*|[\w\W]*\}\}/gm),Fd=te(/<%[\w\W]*|[\w\W]*%>/gm),Ud=te(/\$\{[\w\W]*/gm),Kd=te(/^data-[\-\w.\u00B7-\uFFFF]+$/),Hd=te(/^aria-[\-\w]+$/),Ga=te(/^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i),zd=te(/^(?:\w+script|data):/i),jd=te(/[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g),Ya=te(/^html$/i),qd=te(/^[a-z][.\w]*(-[.\w]+)+$/i);var vo=Object.freeze({__proto__:null,ARIA_ATTR:Hd,ATTR_WHITESPACE:jd,CUSTOM_ELEMENT:qd,DATA_ATTR:Kd,DOCTYPE_NAME:Ya,ERB_EXPR:Fd,IS_ALLOWED_URI:Ga,IS_SCRIPT_OR_DATA:zd,MUSTACHE_EXPR:Bd,TMPLIT_EXPR:Ud});const pt={element:1,text:3,progressingInstruction:7,comment:8,document:9},Wd=function(){return typeof window>"u"?null:window},Vd=function(t,n){if(typeof t!="object"||typeof t.createPolicy!="function")return null;let s=null;const i="data-tt-policy-suffix";n&&n.hasAttribute(i)&&(s=n.getAttribute(i));const o="dompurify"+(s?"#"+s:"");try{return t.createPolicy(o,{createHTML(a){return a},createScriptURL(a){return a}})}catch{return console.warn("TrustedTypes policy "+o+" could not be created."),null}},mo=function(){return{afterSanitizeAttributes:[],afterSanitizeElements:[],afterSanitizeShadowDOM:[],beforeSanitizeAttributes:[],beforeSanitizeElements:[],beforeSanitizeShadowDOM:[],uponSanitizeAttribute:[],uponSanitizeElement:[],uponSanitizeShadowNode:[]}};function Qa(){let e=arguments.length>0&&arguments[0]!==void 0?arguments[0]:Wd();const t=T=>Qa(T);if(t.version="3.3.1",t.removed=[],!e||!e.document||e.document.nodeType!==pt.document||!e.Element)return t.isSupported=!1,t;let{document:n}=e;const s=n,i=s.currentScript,{DocumentFragment:o,HTMLTemplateElement:a,Node:l,Element:r,NodeFilter:p,NamedNodeMap:d=e.NamedNodeMap||e.MozNamedAttrMap,HTMLFormElement:u,DOMParser:h,trustedTypes:v}=e,w=r.prototype,$=ut(w,"cloneNode"),x=ut(w,"remove"),C=ut(w,"nextSibling"),I=ut(w,"childNodes"),R=ut(w,"parentNode");if(typeof a=="function"){const T=n.createElement("template");T.content&&T.content.ownerDocument&&(n=T.content.ownerDocument)}let E,A="";const{implementation:B,createNodeIterator:ue,createDocumentFragment:bn,getElementsByTagName:yn}=n,{importNode:Sr}=s;let V=mo();t.isSupported=typeof Va=="function"&&typeof R=="function"&&B&&B.createHTMLDocument!==void 0;const{MUSTACHE_EXPR:wn,ERB_EXPR:$n,TMPLIT_EXPR:kn,DATA_ATTR:_r,ARIA_ATTR:Tr,IS_SCRIPT_OR_DATA:Cr,ATTR_WHITESPACE:ui,CUSTOM_ELEMENT:Er}=vo;let{IS_ALLOWED_URI:pi}=vo,K=null;const fi=L({},[...po,...Gn,...Yn,...Qn,...fo]);let z=null;const hi=L({},[...ho,...Jn,...go,...Ut]);let D=Object.seal(ms(null,{tagNameCheck:{writable:!0,configurable:!1,enumerable:!0,value:null},attributeNameCheck:{writable:!0,configurable:!1,enumerable:!0,value:null},allowCustomizedBuiltInElements:{writable:!0,configurable:!1,enumerable:!0,value:!1}})),st=null,xn=null;const Ke=Object.seal(ms(null,{tagCheck:{writable:!0,configurable:!1,enumerable:!0,value:null},attributeCheck:{writable:!0,configurable:!1,enumerable:!0,value:null}}));let gi=!0,An=!0,vi=!1,mi=!0,He=!1,Et=!0,Te=!1,Sn=!1,_n=!1,ze=!1,It=!1,Lt=!1,bi=!0,yi=!1;const Ir="user-content-";let Tn=!0,it=!1,je={},ae=null;const Cn=L({},["annotation-xml","audio","colgroup","desc","foreignobject","head","iframe","math","mi","mn","mo","ms","mtext","noembed","noframes","noscript","plaintext","script","style","svg","template","thead","title","video","xmp"]);let wi=null;const $i=L({},["audio","video","img","source","image","track"]);let En=null;const ki=L({},["alt","class","for","id","label","name","pattern","placeholder","role","summary","title","value","style","xmlns"]),Rt="http://www.w3.org/1998/Math/MathML",Mt="http://www.w3.org/2000/svg",pe="http://www.w3.org/1999/xhtml";let qe=pe,In=!1,Ln=null;const Lr=L({},[Rt,Mt,pe],Wn);let Pt=L({},["mi","mo","mn","ms","mtext"]),Nt=L({},["annotation-xml"]);const Rr=L({},["title","style","font","a","script"]);let ot=null;const Mr=["application/xhtml+xml","text/html"],Pr="text/html";let U=null,We=null;const Nr=n.createElement("form"),xi=function(f){return f instanceof RegExp||f instanceof Function},Rn=function(){let f=arguments.length>0&&arguments[0]!==void 0?arguments[0]:{};if(!(We&&We===f)){if((!f||typeof f!="object")&&(f={}),f=ce(f),ot=Mr.indexOf(f.PARSER_MEDIA_TYPE)===-1?Pr:f.PARSER_MEDIA_TYPE,U=ot==="application/xhtml+xml"?Wn:Wt,K=ne(f,"ALLOWED_TAGS")?L({},f.ALLOWED_TAGS,U):fi,z=ne(f,"ALLOWED_ATTR")?L({},f.ALLOWED_ATTR,U):hi,Ln=ne(f,"ALLOWED_NAMESPACES")?L({},f.ALLOWED_NAMESPACES,Wn):Lr,En=ne(f,"ADD_URI_SAFE_ATTR")?L(ce(ki),f.ADD_URI_SAFE_ATTR,U):ki,wi=ne(f,"ADD_DATA_URI_TAGS")?L(ce($i),f.ADD_DATA_URI_TAGS,U):$i,ae=ne(f,"FORBID_CONTENTS")?L({},f.FORBID_CONTENTS,U):Cn,st=ne(f,"FORBID_TAGS")?L({},f.FORBID_TAGS,U):ce({}),xn=ne(f,"FORBID_ATTR")?L({},f.FORBID_ATTR,U):ce({}),je=ne(f,"USE_PROFILES")?f.USE_PROFILES:!1,gi=f.ALLOW_ARIA_ATTR!==!1,An=f.ALLOW_DATA_ATTR!==!1,vi=f.ALLOW_UNKNOWN_PROTOCOLS||!1,mi=f.ALLOW_SELF_CLOSE_IN_ATTR!==!1,He=f.SAFE_FOR_TEMPLATES||!1,Et=f.SAFE_FOR_XML!==!1,Te=f.WHOLE_DOCUMENT||!1,ze=f.RETURN_DOM||!1,It=f.RETURN_DOM_FRAGMENT||!1,Lt=f.RETURN_TRUSTED_TYPE||!1,_n=f.FORCE_BODY||!1,bi=f.SANITIZE_DOM!==!1,yi=f.SANITIZE_NAMED_PROPS||!1,Tn=f.KEEP_CONTENT!==!1,it=f.IN_PLACE||!1,pi=f.ALLOWED_URI_REGEXP||Ga,qe=f.NAMESPACE||pe,Pt=f.MATHML_TEXT_INTEGRATION_POINTS||Pt,Nt=f.HTML_INTEGRATION_POINTS||Nt,D=f.CUSTOM_ELEMENT_HANDLING||{},f.CUSTOM_ELEMENT_HANDLING&&xi(f.CUSTOM_ELEMENT_HANDLING.tagNameCheck)&&(D.tagNameCheck=f.CUSTOM_ELEMENT_HANDLING.tagNameCheck),f.CUSTOM_ELEMENT_HANDLING&&xi(f.CUSTOM_ELEMENT_HANDLING.attributeNameCheck)&&(D.attributeNameCheck=f.CUSTOM_ELEMENT_HANDLING.attributeNameCheck),f.CUSTOM_ELEMENT_HANDLING&&typeof f.CUSTOM_ELEMENT_HANDLING.allowCustomizedBuiltInElements=="boolean"&&(D.allowCustomizedBuiltInElements=f.CUSTOM_ELEMENT_HANDLING.allowCustomizedBuiltInElements),He&&(An=!1),It&&(ze=!0),je&&(K=L({},fo),z=[],je.html===!0&&(L(K,po),L(z,ho)),je.svg===!0&&(L(K,Gn),L(z,Jn),L(z,Ut)),je.svgFilters===!0&&(L(K,Yn),L(z,Jn),L(z,Ut)),je.mathMl===!0&&(L(K,Qn),L(z,go),L(z,Ut))),f.ADD_TAGS&&(typeof f.ADD_TAGS=="function"?Ke.tagCheck=f.ADD_TAGS:(K===fi&&(K=ce(K)),L(K,f.ADD_TAGS,U))),f.ADD_ATTR&&(typeof f.ADD_ATTR=="function"?Ke.attributeCheck=f.ADD_ATTR:(z===hi&&(z=ce(z)),L(z,f.ADD_ATTR,U))),f.ADD_URI_SAFE_ATTR&&L(En,f.ADD_URI_SAFE_ATTR,U),f.FORBID_CONTENTS&&(ae===Cn&&(ae=ce(ae)),L(ae,f.FORBID_CONTENTS,U)),f.ADD_FORBID_CONTENTS&&(ae===Cn&&(ae=ce(ae)),L(ae,f.ADD_FORBID_CONTENTS,U)),Tn&&(K["#text"]=!0),Te&&L(K,["html","head","body"]),K.table&&(L(K,["tbody"]),delete st.tbody),f.TRUSTED_TYPES_POLICY){if(typeof f.TRUSTED_TYPES_POLICY.createHTML!="function")throw dt('TRUSTED_TYPES_POLICY configuration option must provide a "createHTML" hook.');if(typeof f.TRUSTED_TYPES_POLICY.createScriptURL!="function")throw dt('TRUSTED_TYPES_POLICY configuration option must provide a "createScriptURL" hook.');E=f.TRUSTED_TYPES_POLICY,A=E.createHTML("")}else E===void 0&&(E=Vd(v,i)),E!==null&&typeof A=="string"&&(A=E.createHTML(""));Q&&Q(f),We=f}},Ai=L({},[...Gn,...Yn,...Od]),Si=L({},[...Qn,...Dd]),Or=function(f){let k=R(f);(!k||!k.tagName)&&(k={namespaceURI:qe,tagName:"template"});const _=Wt(f.tagName),N=Wt(k.tagName);return Ln[f.namespaceURI]?f.namespaceURI===Mt?k.namespaceURI===pe?_==="svg":k.namespaceURI===Rt?_==="svg"&&(N==="annotation-xml"||Pt[N]):!!Ai[_]:f.namespaceURI===Rt?k.namespaceURI===pe?_==="math":k.namespaceURI===Mt?_==="math"&&Nt[N]:!!Si[_]:f.namespaceURI===pe?k.namespaceURI===Mt&&!Nt[N]||k.namespaceURI===Rt&&!Pt[N]?!1:!Si[_]&&(Rr[_]||!Ai[_]):!!(ot==="application/xhtml+xml"&&Ln[f.namespaceURI]):!1},re=function(f){lt(t.removed,{element:f});try{R(f).removeChild(f)}catch{x(f)}},Ce=function(f,k){try{lt(t.removed,{attribute:k.getAttributeNode(f),from:k})}catch{lt(t.removed,{attribute:null,from:k})}if(k.removeAttribute(f),f==="is")if(ze||It)try{re(k)}catch{}else try{k.setAttribute(f,"")}catch{}},_i=function(f){let k=null,_=null;if(_n)f="<remove></remove>"+f;else{const F=Vn(f,/^[\r\n\t ]+/);_=F&&F[0]}ot==="application/xhtml+xml"&&qe===pe&&(f='<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>'+f+"</body></html>");const N=E?E.createHTML(f):f;if(qe===pe)try{k=new h().parseFromString(N,ot)}catch{}if(!k||!k.documentElement){k=B.createDocument(qe,"template",null);try{k.documentElement.innerHTML=In?A:N}catch{}}const q=k.body||k.documentElement;return f&&_&&q.insertBefore(n.createTextNode(_),q.childNodes[0]||null),qe===pe?yn.call(k,Te?"html":"body")[0]:Te?k.documentElement:q},Ti=function(f){return ue.call(f.ownerDocument||f,f,p.SHOW_ELEMENT|p.SHOW_COMMENT|p.SHOW_TEXT|p.SHOW_PROCESSING_INSTRUCTION|p.SHOW_CDATA_SECTION,null)},Mn=function(f){return f instanceof u&&(typeof f.nodeName!="string"||typeof f.textContent!="string"||typeof f.removeChild!="function"||!(f.attributes instanceof d)||typeof f.removeAttribute!="function"||typeof f.setAttribute!="function"||typeof f.namespaceURI!="string"||typeof f.insertBefore!="function"||typeof f.hasChildNodes!="function")},Ci=function(f){return typeof l=="function"&&f instanceof l};function fe(T,f,k){Ft(T,_=>{_.call(t,f,k,We)})}const Ei=function(f){let k=null;if(fe(V.beforeSanitizeElements,f,null),Mn(f))return re(f),!0;const _=U(f.nodeName);if(fe(V.uponSanitizeElement,f,{tagName:_,allowedTags:K}),Et&&f.hasChildNodes()&&!Ci(f.firstElementChild)&&G(/<[/\w!]/g,f.innerHTML)&&G(/<[/\w!]/g,f.textContent)||f.nodeType===pt.progressingInstruction||Et&&f.nodeType===pt.comment&&G(/<[/\w]/g,f.data))return re(f),!0;if(!(Ke.tagCheck instanceof Function&&Ke.tagCheck(_))&&(!K[_]||st[_])){if(!st[_]&&Li(_)&&(D.tagNameCheck instanceof RegExp&&G(D.tagNameCheck,_)||D.tagNameCheck instanceof Function&&D.tagNameCheck(_)))return!1;if(Tn&&!ae[_]){const N=R(f)||f.parentNode,q=I(f)||f.childNodes;if(q&&N){const F=q.length;for(let Z=F-1;Z>=0;--Z){const he=$(q[Z],!0);he.__removalCount=(f.__removalCount||0)+1,N.insertBefore(he,C(f))}}}return re(f),!0}return f instanceof r&&!Or(f)||(_==="noscript"||_==="noembed"||_==="noframes")&&G(/<\/no(script|embed|frames)/i,f.innerHTML)?(re(f),!0):(He&&f.nodeType===pt.text&&(k=f.textContent,Ft([wn,$n,kn],N=>{k=ct(k,N," ")}),f.textContent!==k&&(lt(t.removed,{element:f.cloneNode()}),f.textContent=k)),fe(V.afterSanitizeElements,f,null),!1)},Ii=function(f,k,_){if(bi&&(k==="id"||k==="name")&&(_ in n||_ in Nr))return!1;if(!(An&&!xn[k]&&G(_r,k))){if(!(gi&&G(Tr,k))){if(!(Ke.attributeCheck instanceof Function&&Ke.attributeCheck(k,f))){if(!z[k]||xn[k]){if(!(Li(f)&&(D.tagNameCheck instanceof RegExp&&G(D.tagNameCheck,f)||D.tagNameCheck instanceof Function&&D.tagNameCheck(f))&&(D.attributeNameCheck instanceof RegExp&&G(D.attributeNameCheck,k)||D.attributeNameCheck instanceof Function&&D.attributeNameCheck(k,f))||k==="is"&&D.allowCustomizedBuiltInElements&&(D.tagNameCheck instanceof RegExp&&G(D.tagNameCheck,_)||D.tagNameCheck instanceof Function&&D.tagNameCheck(_))))return!1}else if(!En[k]){if(!G(pi,ct(_,ui,""))){if(!((k==="src"||k==="xlink:href"||k==="href")&&f!=="script"&&Rd(_,"data:")===0&&wi[f])){if(!(vi&&!G(Cr,ct(_,ui,"")))){if(_)return!1}}}}}}}return!0},Li=function(f){return f!=="annotation-xml"&&Vn(f,Er)},Ri=function(f){fe(V.beforeSanitizeAttributes,f,null);const{attributes:k}=f;if(!k||Mn(f))return;const _={attrName:"",attrValue:"",keepAttr:!0,allowedAttributes:z,forceKeepAttr:void 0};let N=k.length;for(;N--;){const q=k[N],{name:F,namespaceURI:Z,value:he}=q,Ve=U(F),Pn=he;let j=F==="value"?Pn:Md(Pn);if(_.attrName=Ve,_.attrValue=j,_.keepAttr=!0,_.forceKeepAttr=void 0,fe(V.uponSanitizeAttribute,f,_),j=_.attrValue,yi&&(Ve==="id"||Ve==="name")&&(Ce(F,f),j=Ir+j),Et&&G(/((--!?|])>)|<\/(style|title|textarea)/i,j)){Ce(F,f);continue}if(Ve==="attributename"&&Vn(j,"href")){Ce(F,f);continue}if(_.forceKeepAttr)continue;if(!_.keepAttr){Ce(F,f);continue}if(!mi&&G(/\/>/i,j)){Ce(F,f);continue}He&&Ft([wn,$n,kn],Pi=>{j=ct(j,Pi," ")});const Mi=U(f.nodeName);if(!Ii(Mi,Ve,j)){Ce(F,f);continue}if(E&&typeof v=="object"&&typeof v.getAttributeType=="function"&&!Z)switch(v.getAttributeType(Mi,Ve)){case"TrustedHTML":{j=E.createHTML(j);break}case"TrustedScriptURL":{j=E.createScriptURL(j);break}}if(j!==Pn)try{Z?f.setAttributeNS(Z,F,j):f.setAttribute(F,j),Mn(f)?re(f):uo(t.removed)}catch{Ce(F,f)}}fe(V.afterSanitizeAttributes,f,null)},Dr=function T(f){let k=null;const _=Ti(f);for(fe(V.beforeSanitizeShadowDOM,f,null);k=_.nextNode();)fe(V.uponSanitizeShadowNode,k,null),Ei(k),Ri(k),k.content instanceof o&&T(k.content);fe(V.afterSanitizeShadowDOM,f,null)};return t.sanitize=function(T){let f=arguments.length>1&&arguments[1]!==void 0?arguments[1]:{},k=null,_=null,N=null,q=null;if(In=!T,In&&(T="<!-->"),typeof T!="string"&&!Ci(T))if(typeof T.toString=="function"){if(T=T.toString(),typeof T!="string")throw dt("dirty is not a string, aborting")}else throw dt("toString is not a function");if(!t.isSupported)return T;if(Sn||Rn(f),t.removed=[],typeof T=="string"&&(it=!1),it){if(T.nodeName){const he=U(T.nodeName);if(!K[he]||st[he])throw dt("root node is forbidden and cannot be sanitized in-place")}}else if(T instanceof l)k=_i("<!---->"),_=k.ownerDocument.importNode(T,!0),_.nodeType===pt.element&&_.nodeName==="BODY"||_.nodeName==="HTML"?k=_:k.appendChild(_);else{if(!ze&&!He&&!Te&&T.indexOf("<")===-1)return E&&Lt?E.createHTML(T):T;if(k=_i(T),!k)return ze?null:Lt?A:""}k&&_n&&re(k.firstChild);const F=Ti(it?T:k);for(;N=F.nextNode();)Ei(N),Ri(N),N.content instanceof o&&Dr(N.content);if(it)return T;if(ze){if(It)for(q=bn.call(k.ownerDocument);k.firstChild;)q.appendChild(k.firstChild);else q=k;return(z.shadowroot||z.shadowrootmode)&&(q=Sr.call(s,q,!0)),q}let Z=Te?k.outerHTML:k.innerHTML;return Te&&K["!doctype"]&&k.ownerDocument&&k.ownerDocument.doctype&&k.ownerDocument.doctype.name&&G(Ya,k.ownerDocument.doctype.name)&&(Z="<!DOCTYPE "+k.ownerDocument.doctype.name+`>
`+Z),He&&Ft([wn,$n,kn],he=>{Z=ct(Z,he," ")}),E&&Lt?E.createHTML(Z):Z},t.setConfig=function(){let T=arguments.length>0&&arguments[0]!==void 0?arguments[0]:{};Rn(T),Sn=!0},t.clearConfig=function(){We=null,Sn=!1},t.isValidAttribute=function(T,f,k){We||Rn({});const _=U(T),N=U(f);return Ii(_,N,k)},t.addHook=function(T,f){typeof f=="function"&&lt(V[T],f)},t.removeHook=function(T,f){if(f!==void 0){const k=Id(V[T],f);return k===-1?void 0:Ld(V[T],k,1)[0]}return uo(V[T])},t.removeHooks=function(T){V[T]=[]},t.removeAllHooks=function(){V=mo()},t}var ws=Qa();function ei(){return{async:!1,breaks:!1,extensions:null,gfm:!0,hooks:null,pedantic:!1,renderer:null,silent:!1,tokenizer:null,walkTokens:null}}var Ue=ei();function Ja(e){Ue=e}var bt={exec:()=>null};function M(e,t=""){let n=typeof e=="string"?e:e.source,s={replace:(i,o)=>{let a=typeof o=="string"?o:o.source;return a=a.replace(Y.caret,"$1"),n=n.replace(i,a),s},getRegex:()=>new RegExp(n,t)};return s}var Gd=(()=>{try{return!!new RegExp("(?<=1)(?<!1)")}catch{return!1}})(),Y={codeRemoveIndent:/^(?: {1,4}| {0,3}\t)/gm,outputLinkReplace:/\\([\[\]])/g,indentCodeCompensation:/^(\s+)(?:```)/,beginningSpace:/^\s+/,endingHash:/#$/,startingSpaceChar:/^ /,endingSpaceChar:/ $/,nonSpaceChar:/[^ ]/,newLineCharGlobal:/\n/g,tabCharGlobal:/\t/g,multipleSpaceGlobal:/\s+/g,blankLine:/^[ \t]*$/,doubleBlankLine:/\n[ \t]*\n[ \t]*$/,blockquoteStart:/^ {0,3}>/,blockquoteSetextReplace:/\n {0,3}((?:=+|-+) *)(?=\n|$)/g,blockquoteSetextReplace2:/^ {0,3}>[ \t]?/gm,listReplaceTabs:/^\t+/,listReplaceNesting:/^ {1,4}(?=( {4})*[^ ])/g,listIsTask:/^\[[ xX]\] +\S/,listReplaceTask:/^\[[ xX]\] +/,listTaskCheckbox:/\[[ xX]\]/,anyLine:/\n.*\n/,hrefBrackets:/^<(.*)>$/,tableDelimiter:/[:|]/,tableAlignChars:/^\||\| *$/g,tableRowBlankLine:/\n[ \t]*$/,tableAlignRight:/^ *-+: *$/,tableAlignCenter:/^ *:-+: *$/,tableAlignLeft:/^ *:-+ *$/,startATag:/^<a /i,endATag:/^<\/a>/i,startPreScriptTag:/^<(pre|code|kbd|script)(\s|>)/i,endPreScriptTag:/^<\/(pre|code|kbd|script)(\s|>)/i,startAngleBracket:/^</,endAngleBracket:/>$/,pedanticHrefTitle:/^([^'"]*[^\s])\s+(['"])(.*)\2/,unicodeAlphaNumeric:/[\p{L}\p{N}]/u,escapeTest:/[&<>"']/,escapeReplace:/[&<>"']/g,escapeTestNoEncode:/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,escapeReplaceNoEncode:/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,unescapeTest:/&(#(?:\d+)|(?:#x[0-9A-Fa-f]+)|(?:\w+));?/ig,caret:/(^|[^\[])\^/g,percentDecode:/%25/g,findPipe:/\|/g,splitPipe:/ \|/,slashPipe:/\\\|/g,carriageReturn:/\r\n|\r/g,spaceLine:/^ +$/gm,notSpaceStart:/^\S*/,endingNewline:/\n$/,listItemRegex:e=>new RegExp(`^( {0,3}${e})((?:[	 ][^\\n]*)?(?:\\n|$))`),nextBulletRegex:e=>new RegExp(`^ {0,${Math.min(3,e-1)}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`),hrRegex:e=>new RegExp(`^ {0,${Math.min(3,e-1)}}((?:- *){3,}|(?:_ *){3,}|(?:\\* *){3,})(?:\\n+|$)`),fencesBeginRegex:e=>new RegExp(`^ {0,${Math.min(3,e-1)}}(?:\`\`\`|~~~)`),headingBeginRegex:e=>new RegExp(`^ {0,${Math.min(3,e-1)}}#`),htmlBeginRegex:e=>new RegExp(`^ {0,${Math.min(3,e-1)}}<(?:[a-z].*>|!--)`,"i")},Yd=/^(?:[ \t]*(?:\n|$))+/,Qd=/^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,Jd=/^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/,Ct=/^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,Zd=/^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,ti=/(?:[*+-]|\d{1,9}[.)])/,Za=/^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |blockCode|fences|blockquote|heading|html|table))+?)\n {0,3}(=+|-+) *(?:\n+|$)/,Xa=M(Za).replace(/bull/g,ti).replace(/blockCode/g,/(?: {4}| {0,3}\t)/).replace(/fences/g,/ {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g,/ {0,3}>/).replace(/heading/g,/ {0,3}#{1,6}/).replace(/html/g,/ {0,3}<[^\n>]+>\n/).replace(/\|table/g,"").getRegex(),Xd=M(Za).replace(/bull/g,ti).replace(/blockCode/g,/(?: {4}| {0,3}\t)/).replace(/fences/g,/ {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g,/ {0,3}>/).replace(/heading/g,/ {0,3}#{1,6}/).replace(/html/g,/ {0,3}<[^\n>]+>\n/).replace(/table/g,/ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex(),ni=/^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table| +\n)[^\n]+)*)/,eu=/^[^\n]+/,si=/(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+/,tu=M(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace("label",si).replace("title",/(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/).getRegex(),nu=M(/^( {0,3}bull)([ \t][^\n]+?)?(?:\n|$)/).replace(/bull/g,ti).getRegex(),hn="address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul",ii=/<!--(?:-?>|[\s\S]*?(?:-->|$))/,su=M("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n+|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>\\n*|$)|<![A-Z][\\s\\S]*?(?:>\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>\\n*|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|<(?!script|pre|style|textarea)([a-z][\\w-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|</(?!script|pre|style|textarea)[a-z][\\w-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))","i").replace("comment",ii).replace("tag",hn).replace("attribute",/ +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex(),er=M(ni).replace("hr",Ct).replace("heading"," {0,3}#{1,6}(?:\\s|$)").replace("|lheading","").replace("|table","").replace("blockquote"," {0,3}>").replace("fences"," {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list"," {0,3}(?:[*+-]|1[.)]) ").replace("html","</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag",hn).getRegex(),iu=M(/^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/).replace("paragraph",er).getRegex(),oi={blockquote:iu,code:Qd,def:tu,fences:Jd,heading:Zd,hr:Ct,html:su,lheading:Xa,list:nu,newline:Yd,paragraph:er,table:bt,text:eu},bo=M("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)").replace("hr",Ct).replace("heading"," {0,3}#{1,6}(?:\\s|$)").replace("blockquote"," {0,3}>").replace("code","(?: {4}| {0,3}	)[^\\n]").replace("fences"," {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list"," {0,3}(?:[*+-]|1[.)]) ").replace("html","</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag",hn).getRegex(),ou={...oi,lheading:Xd,table:bo,paragraph:M(ni).replace("hr",Ct).replace("heading"," {0,3}#{1,6}(?:\\s|$)").replace("|lheading","").replace("table",bo).replace("blockquote"," {0,3}>").replace("fences"," {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list"," {0,3}(?:[*+-]|1[.)]) ").replace("html","</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag",hn).getRegex()},au={...oi,html:M(`^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`).replace("comment",ii).replace(/tag/g,"(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b").getRegex(),def:/^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/,heading:/^(#{1,6})(.*)(?:\n+|$)/,fences:bt,lheading:/^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/,paragraph:M(ni).replace("hr",Ct).replace("heading",` *#{1,6} *[^
]`).replace("lheading",Xa).replace("|table","").replace("blockquote"," {0,3}>").replace("|fences","").replace("|list","").replace("|html","").replace("|tag","").getRegex()},ru=/^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,lu=/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,tr=/^( {2,}|\\)\n(?!\s*$)/,cu=/^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/,gn=/[\p{P}\p{S}]/u,ai=/[\s\p{P}\p{S}]/u,nr=/[^\s\p{P}\p{S}]/u,du=M(/^((?![*_])punctSpace)/,"u").replace(/punctSpace/g,ai).getRegex(),sr=/(?!~)[\p{P}\p{S}]/u,uu=/(?!~)[\s\p{P}\p{S}]/u,pu=/(?:[^\s\p{P}\p{S}]|~)/u,fu=M(/link|precode-code|html/,"g").replace("link",/\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/).replace("precode-",Gd?"(?<!`)()":"(^^|[^`])").replace("code",/(?<b>`+)[^`]+\k<b>(?!`)/).replace("html",/<(?! )[^<>]*?>/).getRegex(),ir=/^(?:\*+(?:((?!\*)punct)|[^\s*]))|^_+(?:((?!_)punct)|([^\s_]))/,hu=M(ir,"u").replace(/punct/g,gn).getRegex(),gu=M(ir,"u").replace(/punct/g,sr).getRegex(),or="^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)",vu=M(or,"gu").replace(/notPunctSpace/g,nr).replace(/punctSpace/g,ai).replace(/punct/g,gn).getRegex(),mu=M(or,"gu").replace(/notPunctSpace/g,pu).replace(/punctSpace/g,uu).replace(/punct/g,sr).getRegex(),bu=M("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)","gu").replace(/notPunctSpace/g,nr).replace(/punctSpace/g,ai).replace(/punct/g,gn).getRegex(),yu=M(/\\(punct)/,"gu").replace(/punct/g,gn).getRegex(),wu=M(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace("scheme",/[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace("email",/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex(),$u=M(ii).replace("(?:-->|$)","-->").getRegex(),ku=M("^comment|^</[a-zA-Z][\\w:-]*\\s*>|^<[a-zA-Z][\\w-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>").replace("comment",$u).replace("attribute",/\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex(),Zt=/(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+[^`]*?`+(?!`)|[^\[\]\\`])*?/,xu=M(/^!?\[(label)\]\(\s*(href)(?:(?:[ \t]*(?:\n[ \t]*)?)(title))?\s*\)/).replace("label",Zt).replace("href",/<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]*/).replace("title",/"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/).getRegex(),ar=M(/^!?\[(label)\]\[(ref)\]/).replace("label",Zt).replace("ref",si).getRegex(),rr=M(/^!?\[(ref)\](?:\[\])?/).replace("ref",si).getRegex(),Au=M("reflink|nolink(?!\\()","g").replace("reflink",ar).replace("nolink",rr).getRegex(),yo=/[hH][tT][tT][pP][sS]?|[fF][tT][pP]/,ri={_backpedal:bt,anyPunctuation:yu,autolink:wu,blockSkip:fu,br:tr,code:lu,del:bt,emStrongLDelim:hu,emStrongRDelimAst:vu,emStrongRDelimUnd:bu,escape:ru,link:xu,nolink:rr,punctuation:du,reflink:ar,reflinkSearch:Au,tag:ku,text:cu,url:bt},Su={...ri,link:M(/^!?\[(label)\]\((.*?)\)/).replace("label",Zt).getRegex(),reflink:M(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace("label",Zt).getRegex()},$s={...ri,emStrongRDelimAst:mu,emStrongLDelim:gu,url:M(/^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/).replace("protocol",yo).replace("email",/[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/).getRegex(),_backpedal:/(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,del:/^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,text:M(/^([`~]+|[^`~])(?:(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)))/).replace("protocol",yo).getRegex()},_u={...$s,br:M(tr).replace("{2,}","*").getRegex(),text:M($s.text).replace("\\b_","\\b_| {2,}\\n").replace(/\{2,\}/g,"*").getRegex()},Kt={normal:oi,gfm:ou,pedantic:au},ft={normal:ri,gfm:$s,breaks:_u,pedantic:Su},Tu={"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"},wo=e=>Tu[e];function ve(e,t){if(t){if(Y.escapeTest.test(e))return e.replace(Y.escapeReplace,wo)}else if(Y.escapeTestNoEncode.test(e))return e.replace(Y.escapeReplaceNoEncode,wo);return e}function $o(e){try{e=encodeURI(e).replace(Y.percentDecode,"%")}catch{return null}return e}function ko(e,t){let n=e.replace(Y.findPipe,(o,a,l)=>{let r=!1,p=a;for(;--p>=0&&l[p]==="\\";)r=!r;return r?"|":" |"}),s=n.split(Y.splitPipe),i=0;if(s[0].trim()||s.shift(),s.length>0&&!s.at(-1)?.trim()&&s.pop(),t)if(s.length>t)s.splice(t);else for(;s.length<t;)s.push("");for(;i<s.length;i++)s[i]=s[i].trim().replace(Y.slashPipe,"|");return s}function ht(e,t,n){let s=e.length;if(s===0)return"";let i=0;for(;i<s&&e.charAt(s-i-1)===t;)i++;return e.slice(0,s-i)}function Cu(e,t){if(e.indexOf(t[1])===-1)return-1;let n=0;for(let s=0;s<e.length;s++)if(e[s]==="\\")s++;else if(e[s]===t[0])n++;else if(e[s]===t[1]&&(n--,n<0))return s;return n>0?-2:-1}function xo(e,t,n,s,i){let o=t.href,a=t.title||null,l=e[1].replace(i.other.outputLinkReplace,"$1");s.state.inLink=!0;let r={type:e[0].charAt(0)==="!"?"image":"link",raw:n,href:o,title:a,text:l,tokens:s.inlineTokens(l)};return s.state.inLink=!1,r}function Eu(e,t,n){let s=e.match(n.other.indentCodeCompensation);if(s===null)return t;let i=s[1];return t.split(`
`).map(o=>{let a=o.match(n.other.beginningSpace);if(a===null)return o;let[l]=a;return l.length>=i.length?o.slice(i.length):o}).join(`
`)}var Xt=class{options;rules;lexer;constructor(e){this.options=e||Ue}space(e){let t=this.rules.block.newline.exec(e);if(t&&t[0].length>0)return{type:"space",raw:t[0]}}code(e){let t=this.rules.block.code.exec(e);if(t){let n=t[0].replace(this.rules.other.codeRemoveIndent,"");return{type:"code",raw:t[0],codeBlockStyle:"indented",text:this.options.pedantic?n:ht(n,`
`)}}}fences(e){let t=this.rules.block.fences.exec(e);if(t){let n=t[0],s=Eu(n,t[3]||"",this.rules);return{type:"code",raw:n,lang:t[2]?t[2].trim().replace(this.rules.inline.anyPunctuation,"$1"):t[2],text:s}}}heading(e){let t=this.rules.block.heading.exec(e);if(t){let n=t[2].trim();if(this.rules.other.endingHash.test(n)){let s=ht(n,"#");(this.options.pedantic||!s||this.rules.other.endingSpaceChar.test(s))&&(n=s.trim())}return{type:"heading",raw:t[0],depth:t[1].length,text:n,tokens:this.lexer.inline(n)}}}hr(e){let t=this.rules.block.hr.exec(e);if(t)return{type:"hr",raw:ht(t[0],`
`)}}blockquote(e){let t=this.rules.block.blockquote.exec(e);if(t){let n=ht(t[0],`
`).split(`
`),s="",i="",o=[];for(;n.length>0;){let a=!1,l=[],r;for(r=0;r<n.length;r++)if(this.rules.other.blockquoteStart.test(n[r]))l.push(n[r]),a=!0;else if(!a)l.push(n[r]);else break;n=n.slice(r);let p=l.join(`
`),d=p.replace(this.rules.other.blockquoteSetextReplace,`
    $1`).replace(this.rules.other.blockquoteSetextReplace2,"");s=s?`${s}
${p}`:p,i=i?`${i}
${d}`:d;let u=this.lexer.state.top;if(this.lexer.state.top=!0,this.lexer.blockTokens(d,o,!0),this.lexer.state.top=u,n.length===0)break;let h=o.at(-1);if(h?.type==="code")break;if(h?.type==="blockquote"){let v=h,w=v.raw+`
`+n.join(`
`),$=this.blockquote(w);o[o.length-1]=$,s=s.substring(0,s.length-v.raw.length)+$.raw,i=i.substring(0,i.length-v.text.length)+$.text;break}else if(h?.type==="list"){let v=h,w=v.raw+`
`+n.join(`
`),$=this.list(w);o[o.length-1]=$,s=s.substring(0,s.length-h.raw.length)+$.raw,i=i.substring(0,i.length-v.raw.length)+$.raw,n=w.substring(o.at(-1).raw.length).split(`
`);continue}}return{type:"blockquote",raw:s,tokens:o,text:i}}}list(e){let t=this.rules.block.list.exec(e);if(t){let n=t[1].trim(),s=n.length>1,i={type:"list",raw:"",ordered:s,start:s?+n.slice(0,-1):"",loose:!1,items:[]};n=s?`\\d{1,9}\\${n.slice(-1)}`:`\\${n}`,this.options.pedantic&&(n=s?n:"[*+-]");let o=this.rules.other.listItemRegex(n),a=!1;for(;e;){let r=!1,p="",d="";if(!(t=o.exec(e))||this.rules.block.hr.test(e))break;p=t[0],e=e.substring(p.length);let u=t[2].split(`
`,1)[0].replace(this.rules.other.listReplaceTabs,$=>" ".repeat(3*$.length)),h=e.split(`
`,1)[0],v=!u.trim(),w=0;if(this.options.pedantic?(w=2,d=u.trimStart()):v?w=t[1].length+1:(w=t[2].search(this.rules.other.nonSpaceChar),w=w>4?1:w,d=u.slice(w),w+=t[1].length),v&&this.rules.other.blankLine.test(h)&&(p+=h+`
`,e=e.substring(h.length+1),r=!0),!r){let $=this.rules.other.nextBulletRegex(w),x=this.rules.other.hrRegex(w),C=this.rules.other.fencesBeginRegex(w),I=this.rules.other.headingBeginRegex(w),R=this.rules.other.htmlBeginRegex(w);for(;e;){let E=e.split(`
`,1)[0],A;if(h=E,this.options.pedantic?(h=h.replace(this.rules.other.listReplaceNesting,"  "),A=h):A=h.replace(this.rules.other.tabCharGlobal,"    "),C.test(h)||I.test(h)||R.test(h)||$.test(h)||x.test(h))break;if(A.search(this.rules.other.nonSpaceChar)>=w||!h.trim())d+=`
`+A.slice(w);else{if(v||u.replace(this.rules.other.tabCharGlobal,"    ").search(this.rules.other.nonSpaceChar)>=4||C.test(u)||I.test(u)||x.test(u))break;d+=`
`+h}!v&&!h.trim()&&(v=!0),p+=E+`
`,e=e.substring(E.length+1),u=A.slice(w)}}i.loose||(a?i.loose=!0:this.rules.other.doubleBlankLine.test(p)&&(a=!0)),i.items.push({type:"list_item",raw:p,task:!!this.options.gfm&&this.rules.other.listIsTask.test(d),loose:!1,text:d,tokens:[]}),i.raw+=p}let l=i.items.at(-1);if(l)l.raw=l.raw.trimEnd(),l.text=l.text.trimEnd();else return;i.raw=i.raw.trimEnd();for(let r of i.items){if(this.lexer.state.top=!1,r.tokens=this.lexer.blockTokens(r.text,[]),r.task){if(r.text=r.text.replace(this.rules.other.listReplaceTask,""),r.tokens[0]?.type==="text"||r.tokens[0]?.type==="paragraph"){r.tokens[0].raw=r.tokens[0].raw.replace(this.rules.other.listReplaceTask,""),r.tokens[0].text=r.tokens[0].text.replace(this.rules.other.listReplaceTask,"");for(let d=this.lexer.inlineQueue.length-1;d>=0;d--)if(this.rules.other.listIsTask.test(this.lexer.inlineQueue[d].src)){this.lexer.inlineQueue[d].src=this.lexer.inlineQueue[d].src.replace(this.rules.other.listReplaceTask,"");break}}let p=this.rules.other.listTaskCheckbox.exec(r.raw);if(p){let d={type:"checkbox",raw:p[0]+" ",checked:p[0]!=="[ ]"};r.checked=d.checked,i.loose?r.tokens[0]&&["paragraph","text"].includes(r.tokens[0].type)&&"tokens"in r.tokens[0]&&r.tokens[0].tokens?(r.tokens[0].raw=d.raw+r.tokens[0].raw,r.tokens[0].text=d.raw+r.tokens[0].text,r.tokens[0].tokens.unshift(d)):r.tokens.unshift({type:"paragraph",raw:d.raw,text:d.raw,tokens:[d]}):r.tokens.unshift(d)}}if(!i.loose){let p=r.tokens.filter(u=>u.type==="space"),d=p.length>0&&p.some(u=>this.rules.other.anyLine.test(u.raw));i.loose=d}}if(i.loose)for(let r of i.items){r.loose=!0;for(let p of r.tokens)p.type==="text"&&(p.type="paragraph")}return i}}html(e){let t=this.rules.block.html.exec(e);if(t)return{type:"html",block:!0,raw:t[0],pre:t[1]==="pre"||t[1]==="script"||t[1]==="style",text:t[0]}}def(e){let t=this.rules.block.def.exec(e);if(t){let n=t[1].toLowerCase().replace(this.rules.other.multipleSpaceGlobal," "),s=t[2]?t[2].replace(this.rules.other.hrefBrackets,"$1").replace(this.rules.inline.anyPunctuation,"$1"):"",i=t[3]?t[3].substring(1,t[3].length-1).replace(this.rules.inline.anyPunctuation,"$1"):t[3];return{type:"def",tag:n,raw:t[0],href:s,title:i}}}table(e){let t=this.rules.block.table.exec(e);if(!t||!this.rules.other.tableDelimiter.test(t[2]))return;let n=ko(t[1]),s=t[2].replace(this.rules.other.tableAlignChars,"").split("|"),i=t[3]?.trim()?t[3].replace(this.rules.other.tableRowBlankLine,"").split(`
`):[],o={type:"table",raw:t[0],header:[],align:[],rows:[]};if(n.length===s.length){for(let a of s)this.rules.other.tableAlignRight.test(a)?o.align.push("right"):this.rules.other.tableAlignCenter.test(a)?o.align.push("center"):this.rules.other.tableAlignLeft.test(a)?o.align.push("left"):o.align.push(null);for(let a=0;a<n.length;a++)o.header.push({text:n[a],tokens:this.lexer.inline(n[a]),header:!0,align:o.align[a]});for(let a of i)o.rows.push(ko(a,o.header.length).map((l,r)=>({text:l,tokens:this.lexer.inline(l),header:!1,align:o.align[r]})));return o}}lheading(e){let t=this.rules.block.lheading.exec(e);if(t)return{type:"heading",raw:t[0],depth:t[2].charAt(0)==="="?1:2,text:t[1],tokens:this.lexer.inline(t[1])}}paragraph(e){let t=this.rules.block.paragraph.exec(e);if(t){let n=t[1].charAt(t[1].length-1)===`
`?t[1].slice(0,-1):t[1];return{type:"paragraph",raw:t[0],text:n,tokens:this.lexer.inline(n)}}}text(e){let t=this.rules.block.text.exec(e);if(t)return{type:"text",raw:t[0],text:t[0],tokens:this.lexer.inline(t[0])}}escape(e){let t=this.rules.inline.escape.exec(e);if(t)return{type:"escape",raw:t[0],text:t[1]}}tag(e){let t=this.rules.inline.tag.exec(e);if(t)return!this.lexer.state.inLink&&this.rules.other.startATag.test(t[0])?this.lexer.state.inLink=!0:this.lexer.state.inLink&&this.rules.other.endATag.test(t[0])&&(this.lexer.state.inLink=!1),!this.lexer.state.inRawBlock&&this.rules.other.startPreScriptTag.test(t[0])?this.lexer.state.inRawBlock=!0:this.lexer.state.inRawBlock&&this.rules.other.endPreScriptTag.test(t[0])&&(this.lexer.state.inRawBlock=!1),{type:"html",raw:t[0],inLink:this.lexer.state.inLink,inRawBlock:this.lexer.state.inRawBlock,block:!1,text:t[0]}}link(e){let t=this.rules.inline.link.exec(e);if(t){let n=t[2].trim();if(!this.options.pedantic&&this.rules.other.startAngleBracket.test(n)){if(!this.rules.other.endAngleBracket.test(n))return;let o=ht(n.slice(0,-1),"\\");if((n.length-o.length)%2===0)return}else{let o=Cu(t[2],"()");if(o===-2)return;if(o>-1){let a=(t[0].indexOf("!")===0?5:4)+t[1].length+o;t[2]=t[2].substring(0,o),t[0]=t[0].substring(0,a).trim(),t[3]=""}}let s=t[2],i="";if(this.options.pedantic){let o=this.rules.other.pedanticHrefTitle.exec(s);o&&(s=o[1],i=o[3])}else i=t[3]?t[3].slice(1,-1):"";return s=s.trim(),this.rules.other.startAngleBracket.test(s)&&(this.options.pedantic&&!this.rules.other.endAngleBracket.test(n)?s=s.slice(1):s=s.slice(1,-1)),xo(t,{href:s&&s.replace(this.rules.inline.anyPunctuation,"$1"),title:i&&i.replace(this.rules.inline.anyPunctuation,"$1")},t[0],this.lexer,this.rules)}}reflink(e,t){let n;if((n=this.rules.inline.reflink.exec(e))||(n=this.rules.inline.nolink.exec(e))){let s=(n[2]||n[1]).replace(this.rules.other.multipleSpaceGlobal," "),i=t[s.toLowerCase()];if(!i){let o=n[0].charAt(0);return{type:"text",raw:o,text:o}}return xo(n,i,n[0],this.lexer,this.rules)}}emStrong(e,t,n=""){let s=this.rules.inline.emStrongLDelim.exec(e);if(!(!s||s[3]&&n.match(this.rules.other.unicodeAlphaNumeric))&&(!(s[1]||s[2])||!n||this.rules.inline.punctuation.exec(n))){let i=[...s[0]].length-1,o,a,l=i,r=0,p=s[0][0]==="*"?this.rules.inline.emStrongRDelimAst:this.rules.inline.emStrongRDelimUnd;for(p.lastIndex=0,t=t.slice(-1*e.length+i);(s=p.exec(t))!=null;){if(o=s[1]||s[2]||s[3]||s[4]||s[5]||s[6],!o)continue;if(a=[...o].length,s[3]||s[4]){l+=a;continue}else if((s[5]||s[6])&&i%3&&!((i+a)%3)){r+=a;continue}if(l-=a,l>0)continue;a=Math.min(a,a+l+r);let d=[...s[0]][0].length,u=e.slice(0,i+s.index+d+a);if(Math.min(i,a)%2){let v=u.slice(1,-1);return{type:"em",raw:u,text:v,tokens:this.lexer.inlineTokens(v)}}let h=u.slice(2,-2);return{type:"strong",raw:u,text:h,tokens:this.lexer.inlineTokens(h)}}}}codespan(e){let t=this.rules.inline.code.exec(e);if(t){let n=t[2].replace(this.rules.other.newLineCharGlobal," "),s=this.rules.other.nonSpaceChar.test(n),i=this.rules.other.startingSpaceChar.test(n)&&this.rules.other.endingSpaceChar.test(n);return s&&i&&(n=n.substring(1,n.length-1)),{type:"codespan",raw:t[0],text:n}}}br(e){let t=this.rules.inline.br.exec(e);if(t)return{type:"br",raw:t[0]}}del(e){let t=this.rules.inline.del.exec(e);if(t)return{type:"del",raw:t[0],text:t[2],tokens:this.lexer.inlineTokens(t[2])}}autolink(e){let t=this.rules.inline.autolink.exec(e);if(t){let n,s;return t[2]==="@"?(n=t[1],s="mailto:"+n):(n=t[1],s=n),{type:"link",raw:t[0],text:n,href:s,tokens:[{type:"text",raw:n,text:n}]}}}url(e){let t;if(t=this.rules.inline.url.exec(e)){let n,s;if(t[2]==="@")n=t[0],s="mailto:"+n;else{let i;do i=t[0],t[0]=this.rules.inline._backpedal.exec(t[0])?.[0]??"";while(i!==t[0]);n=t[0],t[1]==="www."?s="http://"+t[0]:s=t[0]}return{type:"link",raw:t[0],text:n,href:s,tokens:[{type:"text",raw:n,text:n}]}}}inlineText(e){let t=this.rules.inline.text.exec(e);if(t){let n=this.lexer.state.inRawBlock;return{type:"text",raw:t[0],text:t[0],escaped:n}}}},se=class ks{tokens;options;state;inlineQueue;tokenizer;constructor(t){this.tokens=[],this.tokens.links=Object.create(null),this.options=t||Ue,this.options.tokenizer=this.options.tokenizer||new Xt,this.tokenizer=this.options.tokenizer,this.tokenizer.options=this.options,this.tokenizer.lexer=this,this.inlineQueue=[],this.state={inLink:!1,inRawBlock:!1,top:!0};let n={other:Y,block:Kt.normal,inline:ft.normal};this.options.pedantic?(n.block=Kt.pedantic,n.inline=ft.pedantic):this.options.gfm&&(n.block=Kt.gfm,this.options.breaks?n.inline=ft.breaks:n.inline=ft.gfm),this.tokenizer.rules=n}static get rules(){return{block:Kt,inline:ft}}static lex(t,n){return new ks(n).lex(t)}static lexInline(t,n){return new ks(n).inlineTokens(t)}lex(t){t=t.replace(Y.carriageReturn,`
`),this.blockTokens(t,this.tokens);for(let n=0;n<this.inlineQueue.length;n++){let s=this.inlineQueue[n];this.inlineTokens(s.src,s.tokens)}return this.inlineQueue=[],this.tokens}blockTokens(t,n=[],s=!1){for(this.options.pedantic&&(t=t.replace(Y.tabCharGlobal,"    ").replace(Y.spaceLine,""));t;){let i;if(this.options.extensions?.block?.some(a=>(i=a.call({lexer:this},t,n))?(t=t.substring(i.raw.length),n.push(i),!0):!1))continue;if(i=this.tokenizer.space(t)){t=t.substring(i.raw.length);let a=n.at(-1);i.raw.length===1&&a!==void 0?a.raw+=`
`:n.push(i);continue}if(i=this.tokenizer.code(t)){t=t.substring(i.raw.length);let a=n.at(-1);a?.type==="paragraph"||a?.type==="text"?(a.raw+=(a.raw.endsWith(`
`)?"":`
`)+i.raw,a.text+=`
`+i.text,this.inlineQueue.at(-1).src=a.text):n.push(i);continue}if(i=this.tokenizer.fences(t)){t=t.substring(i.raw.length),n.push(i);continue}if(i=this.tokenizer.heading(t)){t=t.substring(i.raw.length),n.push(i);continue}if(i=this.tokenizer.hr(t)){t=t.substring(i.raw.length),n.push(i);continue}if(i=this.tokenizer.blockquote(t)){t=t.substring(i.raw.length),n.push(i);continue}if(i=this.tokenizer.list(t)){t=t.substring(i.raw.length),n.push(i);continue}if(i=this.tokenizer.html(t)){t=t.substring(i.raw.length),n.push(i);continue}if(i=this.tokenizer.def(t)){t=t.substring(i.raw.length);let a=n.at(-1);a?.type==="paragraph"||a?.type==="text"?(a.raw+=(a.raw.endsWith(`
`)?"":`
`)+i.raw,a.text+=`
`+i.raw,this.inlineQueue.at(-1).src=a.text):this.tokens.links[i.tag]||(this.tokens.links[i.tag]={href:i.href,title:i.title},n.push(i));continue}if(i=this.tokenizer.table(t)){t=t.substring(i.raw.length),n.push(i);continue}if(i=this.tokenizer.lheading(t)){t=t.substring(i.raw.length),n.push(i);continue}let o=t;if(this.options.extensions?.startBlock){let a=1/0,l=t.slice(1),r;this.options.extensions.startBlock.forEach(p=>{r=p.call({lexer:this},l),typeof r=="number"&&r>=0&&(a=Math.min(a,r))}),a<1/0&&a>=0&&(o=t.substring(0,a+1))}if(this.state.top&&(i=this.tokenizer.paragraph(o))){let a=n.at(-1);s&&a?.type==="paragraph"?(a.raw+=(a.raw.endsWith(`
`)?"":`
`)+i.raw,a.text+=`
`+i.text,this.inlineQueue.pop(),this.inlineQueue.at(-1).src=a.text):n.push(i),s=o.length!==t.length,t=t.substring(i.raw.length);continue}if(i=this.tokenizer.text(t)){t=t.substring(i.raw.length);let a=n.at(-1);a?.type==="text"?(a.raw+=(a.raw.endsWith(`
`)?"":`
`)+i.raw,a.text+=`
`+i.text,this.inlineQueue.pop(),this.inlineQueue.at(-1).src=a.text):n.push(i);continue}if(t){let a="Infinite loop on byte: "+t.charCodeAt(0);if(this.options.silent){console.error(a);break}else throw new Error(a)}}return this.state.top=!0,n}inline(t,n=[]){return this.inlineQueue.push({src:t,tokens:n}),n}inlineTokens(t,n=[]){let s=t,i=null;if(this.tokens.links){let r=Object.keys(this.tokens.links);if(r.length>0)for(;(i=this.tokenizer.rules.inline.reflinkSearch.exec(s))!=null;)r.includes(i[0].slice(i[0].lastIndexOf("[")+1,-1))&&(s=s.slice(0,i.index)+"["+"a".repeat(i[0].length-2)+"]"+s.slice(this.tokenizer.rules.inline.reflinkSearch.lastIndex))}for(;(i=this.tokenizer.rules.inline.anyPunctuation.exec(s))!=null;)s=s.slice(0,i.index)+"++"+s.slice(this.tokenizer.rules.inline.anyPunctuation.lastIndex);let o;for(;(i=this.tokenizer.rules.inline.blockSkip.exec(s))!=null;)o=i[2]?i[2].length:0,s=s.slice(0,i.index+o)+"["+"a".repeat(i[0].length-o-2)+"]"+s.slice(this.tokenizer.rules.inline.blockSkip.lastIndex);s=this.options.hooks?.emStrongMask?.call({lexer:this},s)??s;let a=!1,l="";for(;t;){a||(l=""),a=!1;let r;if(this.options.extensions?.inline?.some(d=>(r=d.call({lexer:this},t,n))?(t=t.substring(r.raw.length),n.push(r),!0):!1))continue;if(r=this.tokenizer.escape(t)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.tag(t)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.link(t)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.reflink(t,this.tokens.links)){t=t.substring(r.raw.length);let d=n.at(-1);r.type==="text"&&d?.type==="text"?(d.raw+=r.raw,d.text+=r.text):n.push(r);continue}if(r=this.tokenizer.emStrong(t,s,l)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.codespan(t)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.br(t)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.del(t)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.autolink(t)){t=t.substring(r.raw.length),n.push(r);continue}if(!this.state.inLink&&(r=this.tokenizer.url(t))){t=t.substring(r.raw.length),n.push(r);continue}let p=t;if(this.options.extensions?.startInline){let d=1/0,u=t.slice(1),h;this.options.extensions.startInline.forEach(v=>{h=v.call({lexer:this},u),typeof h=="number"&&h>=0&&(d=Math.min(d,h))}),d<1/0&&d>=0&&(p=t.substring(0,d+1))}if(r=this.tokenizer.inlineText(p)){t=t.substring(r.raw.length),r.raw.slice(-1)!=="_"&&(l=r.raw.slice(-1)),a=!0;let d=n.at(-1);d?.type==="text"?(d.raw+=r.raw,d.text+=r.text):n.push(r);continue}if(t){let d="Infinite loop on byte: "+t.charCodeAt(0);if(this.options.silent){console.error(d);break}else throw new Error(d)}}return n}},en=class{options;parser;constructor(e){this.options=e||Ue}space(e){return""}code({text:e,lang:t,escaped:n}){let s=(t||"").match(Y.notSpaceStart)?.[0],i=e.replace(Y.endingNewline,"")+`
`;return s?'<pre><code class="language-'+ve(s)+'">'+(n?i:ve(i,!0))+`</code></pre>
`:"<pre><code>"+(n?i:ve(i,!0))+`</code></pre>
`}blockquote({tokens:e}){return`<blockquote>
${this.parser.parse(e)}</blockquote>
`}html({text:e}){return e}def(e){return""}heading({tokens:e,depth:t}){return`<h${t}>${this.parser.parseInline(e)}</h${t}>
`}hr(e){return`<hr>
`}list(e){let t=e.ordered,n=e.start,s="";for(let a=0;a<e.items.length;a++){let l=e.items[a];s+=this.listitem(l)}let i=t?"ol":"ul",o=t&&n!==1?' start="'+n+'"':"";return"<"+i+o+`>
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
`}strong({tokens:e}){return`<strong>${this.parser.parseInline(e)}</strong>`}em({tokens:e}){return`<em>${this.parser.parseInline(e)}</em>`}codespan({text:e}){return`<code>${ve(e,!0)}</code>`}br(e){return"<br>"}del({tokens:e}){return`<del>${this.parser.parseInline(e)}</del>`}link({href:e,title:t,tokens:n}){let s=this.parser.parseInline(n),i=$o(e);if(i===null)return s;e=i;let o='<a href="'+e+'"';return t&&(o+=' title="'+ve(t)+'"'),o+=">"+s+"</a>",o}image({href:e,title:t,text:n,tokens:s}){s&&(n=this.parser.parseInline(s,this.parser.textRenderer));let i=$o(e);if(i===null)return ve(n);e=i;let o=`<img src="${e}" alt="${n}"`;return t&&(o+=` title="${ve(t)}"`),o+=">",o}text(e){return"tokens"in e&&e.tokens?this.parser.parseInline(e.tokens):"escaped"in e&&e.escaped?e.text:ve(e.text)}},li=class{strong({text:e}){return e}em({text:e}){return e}codespan({text:e}){return e}del({text:e}){return e}html({text:e}){return e}text({text:e}){return e}link({text:e}){return""+e}image({text:e}){return""+e}br(){return""}checkbox({raw:e}){return e}},ie=class xs{options;renderer;textRenderer;constructor(t){this.options=t||Ue,this.options.renderer=this.options.renderer||new en,this.renderer=this.options.renderer,this.renderer.options=this.options,this.renderer.parser=this,this.textRenderer=new li}static parse(t,n){return new xs(n).parse(t)}static parseInline(t,n){return new xs(n).parseInline(t)}parse(t){let n="";for(let s=0;s<t.length;s++){let i=t[s];if(this.options.extensions?.renderers?.[i.type]){let a=i,l=this.options.extensions.renderers[a.type].call({parser:this},a);if(l!==!1||!["space","hr","heading","code","table","blockquote","list","html","def","paragraph","text"].includes(a.type)){n+=l||"";continue}}let o=i;switch(o.type){case"space":{n+=this.renderer.space(o);break}case"hr":{n+=this.renderer.hr(o);break}case"heading":{n+=this.renderer.heading(o);break}case"code":{n+=this.renderer.code(o);break}case"table":{n+=this.renderer.table(o);break}case"blockquote":{n+=this.renderer.blockquote(o);break}case"list":{n+=this.renderer.list(o);break}case"checkbox":{n+=this.renderer.checkbox(o);break}case"html":{n+=this.renderer.html(o);break}case"def":{n+=this.renderer.def(o);break}case"paragraph":{n+=this.renderer.paragraph(o);break}case"text":{n+=this.renderer.text(o);break}default:{let a='Token with "'+o.type+'" type was not found.';if(this.options.silent)return console.error(a),"";throw new Error(a)}}}return n}parseInline(t,n=this.renderer){let s="";for(let i=0;i<t.length;i++){let o=t[i];if(this.options.extensions?.renderers?.[o.type]){let l=this.options.extensions.renderers[o.type].call({parser:this},o);if(l!==!1||!["escape","html","link","image","strong","em","codespan","br","del","text"].includes(o.type)){s+=l||"";continue}}let a=o;switch(a.type){case"escape":{s+=n.text(a);break}case"html":{s+=n.html(a);break}case"link":{s+=n.link(a);break}case"image":{s+=n.image(a);break}case"checkbox":{s+=n.checkbox(a);break}case"strong":{s+=n.strong(a);break}case"em":{s+=n.em(a);break}case"codespan":{s+=n.codespan(a);break}case"br":{s+=n.br(a);break}case"del":{s+=n.del(a);break}case"text":{s+=n.text(a);break}default:{let l='Token with "'+a.type+'" type was not found.';if(this.options.silent)return console.error(l),"";throw new Error(l)}}}return s}},gt=class{options;block;constructor(e){this.options=e||Ue}static passThroughHooks=new Set(["preprocess","postprocess","processAllTokens","emStrongMask"]);static passThroughHooksRespectAsync=new Set(["preprocess","postprocess","processAllTokens"]);preprocess(e){return e}postprocess(e){return e}processAllTokens(e){return e}emStrongMask(e){return e}provideLexer(){return this.block?se.lex:se.lexInline}provideParser(){return this.block?ie.parse:ie.parseInline}},Iu=class{defaults=ei();options=this.setOptions;parse=this.parseMarkdown(!0);parseInline=this.parseMarkdown(!1);Parser=ie;Renderer=en;TextRenderer=li;Lexer=se;Tokenizer=Xt;Hooks=gt;constructor(...e){this.use(...e)}walkTokens(e,t){let n=[];for(let s of e)switch(n=n.concat(t.call(this,s)),s.type){case"table":{let i=s;for(let o of i.header)n=n.concat(this.walkTokens(o.tokens,t));for(let o of i.rows)for(let a of o)n=n.concat(this.walkTokens(a.tokens,t));break}case"list":{let i=s;n=n.concat(this.walkTokens(i.items,t));break}default:{let i=s;this.defaults.extensions?.childTokens?.[i.type]?this.defaults.extensions.childTokens[i.type].forEach(o=>{let a=i[o].flat(1/0);n=n.concat(this.walkTokens(a,t))}):i.tokens&&(n=n.concat(this.walkTokens(i.tokens,t)))}}return n}use(...e){let t=this.defaults.extensions||{renderers:{},childTokens:{}};return e.forEach(n=>{let s={...n};if(s.async=this.defaults.async||s.async||!1,n.extensions&&(n.extensions.forEach(i=>{if(!i.name)throw new Error("extension name required");if("renderer"in i){let o=t.renderers[i.name];o?t.renderers[i.name]=function(...a){let l=i.renderer.apply(this,a);return l===!1&&(l=o.apply(this,a)),l}:t.renderers[i.name]=i.renderer}if("tokenizer"in i){if(!i.level||i.level!=="block"&&i.level!=="inline")throw new Error("extension level must be 'block' or 'inline'");let o=t[i.level];o?o.unshift(i.tokenizer):t[i.level]=[i.tokenizer],i.start&&(i.level==="block"?t.startBlock?t.startBlock.push(i.start):t.startBlock=[i.start]:i.level==="inline"&&(t.startInline?t.startInline.push(i.start):t.startInline=[i.start]))}"childTokens"in i&&i.childTokens&&(t.childTokens[i.name]=i.childTokens)}),s.extensions=t),n.renderer){let i=this.defaults.renderer||new en(this.defaults);for(let o in n.renderer){if(!(o in i))throw new Error(`renderer '${o}' does not exist`);if(["options","parser"].includes(o))continue;let a=o,l=n.renderer[a],r=i[a];i[a]=(...p)=>{let d=l.apply(i,p);return d===!1&&(d=r.apply(i,p)),d||""}}s.renderer=i}if(n.tokenizer){let i=this.defaults.tokenizer||new Xt(this.defaults);for(let o in n.tokenizer){if(!(o in i))throw new Error(`tokenizer '${o}' does not exist`);if(["options","rules","lexer"].includes(o))continue;let a=o,l=n.tokenizer[a],r=i[a];i[a]=(...p)=>{let d=l.apply(i,p);return d===!1&&(d=r.apply(i,p)),d}}s.tokenizer=i}if(n.hooks){let i=this.defaults.hooks||new gt;for(let o in n.hooks){if(!(o in i))throw new Error(`hook '${o}' does not exist`);if(["options","block"].includes(o))continue;let a=o,l=n.hooks[a],r=i[a];gt.passThroughHooks.has(o)?i[a]=p=>{if(this.defaults.async&&gt.passThroughHooksRespectAsync.has(o))return(async()=>{let u=await l.call(i,p);return r.call(i,u)})();let d=l.call(i,p);return r.call(i,d)}:i[a]=(...p)=>{if(this.defaults.async)return(async()=>{let u=await l.apply(i,p);return u===!1&&(u=await r.apply(i,p)),u})();let d=l.apply(i,p);return d===!1&&(d=r.apply(i,p)),d}}s.hooks=i}if(n.walkTokens){let i=this.defaults.walkTokens,o=n.walkTokens;s.walkTokens=function(a){let l=[];return l.push(o.call(this,a)),i&&(l=l.concat(i.call(this,a))),l}}this.defaults={...this.defaults,...s}}),this}setOptions(e){return this.defaults={...this.defaults,...e},this}lexer(e,t){return se.lex(e,t??this.defaults)}parser(e,t){return ie.parse(e,t??this.defaults)}parseMarkdown(e){return(t,n)=>{let s={...n},i={...this.defaults,...s},o=this.onError(!!i.silent,!!i.async);if(this.defaults.async===!0&&s.async===!1)return o(new Error("marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise."));if(typeof t>"u"||t===null)return o(new Error("marked(): input parameter is undefined or null"));if(typeof t!="string")return o(new Error("marked(): input parameter is of type "+Object.prototype.toString.call(t)+", string expected"));if(i.hooks&&(i.hooks.options=i,i.hooks.block=e),i.async)return(async()=>{let a=i.hooks?await i.hooks.preprocess(t):t,l=await(i.hooks?await i.hooks.provideLexer():e?se.lex:se.lexInline)(a,i),r=i.hooks?await i.hooks.processAllTokens(l):l;i.walkTokens&&await Promise.all(this.walkTokens(r,i.walkTokens));let p=await(i.hooks?await i.hooks.provideParser():e?ie.parse:ie.parseInline)(r,i);return i.hooks?await i.hooks.postprocess(p):p})().catch(o);try{i.hooks&&(t=i.hooks.preprocess(t));let a=(i.hooks?i.hooks.provideLexer():e?se.lex:se.lexInline)(t,i);i.hooks&&(a=i.hooks.processAllTokens(a)),i.walkTokens&&this.walkTokens(a,i.walkTokens);let l=(i.hooks?i.hooks.provideParser():e?ie.parse:ie.parseInline)(a,i);return i.hooks&&(l=i.hooks.postprocess(l)),l}catch(a){return o(a)}}}onError(e,t){return n=>{if(n.message+=`
Please report this to https://github.com/markedjs/marked.`,e){let s="<p>An error occurred:</p><pre>"+ve(n.message+"",!0)+"</pre>";return t?Promise.resolve(s):s}if(t)return Promise.reject(n);throw n}}},Fe=new Iu;function P(e,t){return Fe.parse(e,t)}P.options=P.setOptions=function(e){return Fe.setOptions(e),P.defaults=Fe.defaults,Ja(P.defaults),P};P.getDefaults=ei;P.defaults=Ue;P.use=function(...e){return Fe.use(...e),P.defaults=Fe.defaults,Ja(P.defaults),P};P.walkTokens=function(e,t){return Fe.walkTokens(e,t)};P.parseInline=Fe.parseInline;P.Parser=ie;P.parser=ie.parse;P.Renderer=en;P.TextRenderer=li;P.Lexer=se;P.lexer=se.lex;P.Tokenizer=Xt;P.Hooks=gt;P.parse=P;P.options;P.setOptions;P.use;P.walkTokens;P.parseInline;ie.parse;se.lex;P.setOptions({gfm:!0,breaks:!0,mangle:!1});const Ao=["a","b","blockquote","br","code","del","em","h1","h2","h3","h4","hr","i","li","ol","p","pre","strong","table","tbody","td","th","thead","tr","ul"],So=["class","href","rel","target","title","start"];let _o=!1;const Lu=14e4,Ru=4e4,Mu=200,Zn=5e4,Pe=new Map;function Pu(e){const t=Pe.get(e);return t===void 0?null:(Pe.delete(e),Pe.set(e,t),t)}function To(e,t){if(Pe.set(e,t),Pe.size<=Mu)return;const n=Pe.keys().next().value;n&&Pe.delete(n)}function Nu(){_o||(_o=!0,ws.addHook("afterSanitizeAttributes",e=>{!(e instanceof HTMLAnchorElement)||!e.getAttribute("href")||(e.setAttribute("rel","noreferrer noopener"),e.setAttribute("target","_blank"))}))}function As(e){const t=e.trim();if(!t)return"";if(Nu(),t.length<=Zn){const a=Pu(t);if(a!==null)return a}const n=la(t,Lu),s=n.truncated?`

… truncated (${n.total} chars, showing first ${n.text.length}).`:"";if(n.text.length>Ru){const l=`<pre class="code-block">${Ou(`${n.text}${s}`)}</pre>`,r=ws.sanitize(l,{ALLOWED_TAGS:Ao,ALLOWED_ATTR:So});return t.length<=Zn&&To(t,r),r}const i=P.parse(`${n.text}${s}`),o=ws.sanitize(i,{ALLOWED_TAGS:Ao,ALLOWED_ATTR:So});return t.length<=Zn&&To(t,o),o}function Ou(e){return e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}function Du(e,t){return c`<span class=${t} aria-hidden="true">${e}</span>`}function Ht(e,t){e&&(e.textContent=t)}const Bu=1500,Fu=2e3,lr="Copy as markdown",Uu="Copied",Ku="Copy failed",Xn="📋",Hu="✓",zu="!";async function ju(e){if(!e)return!1;try{return await navigator.clipboard.writeText(e),!0}catch{return!1}}function zt(e,t){e.title=t,e.setAttribute("aria-label",t)}function qu(e){const t=e.label??lr;return c`
    <button
      class="chat-copy-btn"
      type="button"
      title=${t}
      aria-label=${t}
      @click=${async n=>{const s=n.currentTarget,i=s?.querySelector(".chat-copy-btn__icon");if(!s||s.dataset.copying==="1")return;s.dataset.copying="1",s.setAttribute("aria-busy","true"),s.disabled=!0;const o=await ju(e.text());if(s.isConnected){if(delete s.dataset.copying,s.removeAttribute("aria-busy"),s.disabled=!1,!o){s.dataset.error="1",zt(s,Ku),Ht(i,zu),window.setTimeout(()=>{s.isConnected&&(delete s.dataset.error,zt(s,t),Ht(i,Xn))},Fu);return}s.dataset.copied="1",zt(s,Uu),Ht(i,Hu),window.setTimeout(()=>{s.isConnected&&(delete s.dataset.copied,zt(s,t),Ht(i,Xn))},Bu)}}}
    >
      ${Du(Xn,"chat-copy-btn__icon")}
    </button>
  `}function Wu(e){return qu({text:()=>e,label:lr})}const Vu={emoji:"🧩",detailKeys:["command","path","url","targetUrl","targetId","ref","element","node","nodeId","id","requestId","to","channelId","guildId","userId","name","query","pattern","messageId"]},Gu={bash:{emoji:"🛠️",title:"Bash",detailKeys:["command"]},process:{emoji:"🧰",title:"Process",detailKeys:["sessionId"]},read:{emoji:"📖",title:"Read",detailKeys:["path"]},write:{emoji:"✍️",title:"Write",detailKeys:["path"]},edit:{emoji:"📝",title:"Edit",detailKeys:["path"]},attach:{emoji:"📎",title:"Attach",detailKeys:["path","url","fileName"]},browser:{emoji:"🌐",title:"Browser",actions:{status:{label:"status"},start:{label:"start"},stop:{label:"stop"},tabs:{label:"tabs"},open:{label:"open",detailKeys:["targetUrl"]},focus:{label:"focus",detailKeys:["targetId"]},close:{label:"close",detailKeys:["targetId"]},snapshot:{label:"snapshot",detailKeys:["targetUrl","targetId","ref","element","format"]},screenshot:{label:"screenshot",detailKeys:["targetUrl","targetId","ref","element"]},navigate:{label:"navigate",detailKeys:["targetUrl","targetId"]},console:{label:"console",detailKeys:["level","targetId"]},pdf:{label:"pdf",detailKeys:["targetId"]},upload:{label:"upload",detailKeys:["paths","ref","inputRef","element","targetId"]},dialog:{label:"dialog",detailKeys:["accept","promptText","targetId"]},act:{label:"act",detailKeys:["request.kind","request.ref","request.selector","request.text","request.value"]}}},canvas:{emoji:"🖼️",title:"Canvas",actions:{present:{label:"present",detailKeys:["target","node","nodeId"]},hide:{label:"hide",detailKeys:["node","nodeId"]},navigate:{label:"navigate",detailKeys:["url","node","nodeId"]},eval:{label:"eval",detailKeys:["javaScript","node","nodeId"]},snapshot:{label:"snapshot",detailKeys:["format","node","nodeId"]},a2ui_push:{label:"A2UI push",detailKeys:["jsonlPath","node","nodeId"]},a2ui_reset:{label:"A2UI reset",detailKeys:["node","nodeId"]}}},nodes:{emoji:"📱",title:"Nodes",actions:{status:{label:"status"},describe:{label:"describe",detailKeys:["node","nodeId"]},pending:{label:"pending"},approve:{label:"approve",detailKeys:["requestId"]},reject:{label:"reject",detailKeys:["requestId"]},notify:{label:"notify",detailKeys:["node","nodeId","title","body"]},camera_snap:{label:"camera snap",detailKeys:["node","nodeId","facing","deviceId"]},camera_list:{label:"camera list",detailKeys:["node","nodeId"]},camera_clip:{label:"camera clip",detailKeys:["node","nodeId","facing","duration","durationMs"]},screen_record:{label:"screen record",detailKeys:["node","nodeId","duration","durationMs","fps","screenIndex"]}}},cron:{emoji:"⏰",title:"Cron",actions:{status:{label:"status"},list:{label:"list"},add:{label:"add",detailKeys:["job.name","job.id","job.schedule","job.cron"]},update:{label:"update",detailKeys:["id"]},remove:{label:"remove",detailKeys:["id"]},run:{label:"run",detailKeys:["id"]},runs:{label:"runs",detailKeys:["id"]},wake:{label:"wake",detailKeys:["text","mode"]}}},gateway:{emoji:"🔌",title:"Gateway",actions:{restart:{label:"restart",detailKeys:["reason","delayMs"]},"config.get":{label:"config get"},"config.schema":{label:"config schema"},"config.apply":{label:"config apply",detailKeys:["restartDelayMs"]},"update.run":{label:"update run",detailKeys:["restartDelayMs"]}}},whatsapp_login:{emoji:"🟢",title:"WhatsApp Login",actions:{start:{label:"start"},wait:{label:"wait"}}},discord:{emoji:"💬",title:"Discord",actions:{react:{label:"react",detailKeys:["channelId","messageId","emoji"]},reactions:{label:"reactions",detailKeys:["channelId","messageId"]},sticker:{label:"sticker",detailKeys:["to","stickerIds"]},poll:{label:"poll",detailKeys:["question","to"]},permissions:{label:"permissions",detailKeys:["channelId"]},readMessages:{label:"read messages",detailKeys:["channelId","limit"]},sendMessage:{label:"send",detailKeys:["to","content"]},editMessage:{label:"edit",detailKeys:["channelId","messageId"]},deleteMessage:{label:"delete",detailKeys:["channelId","messageId"]},threadCreate:{label:"thread create",detailKeys:["channelId","name"]},threadList:{label:"thread list",detailKeys:["guildId","channelId"]},threadReply:{label:"thread reply",detailKeys:["channelId","content"]},pinMessage:{label:"pin",detailKeys:["channelId","messageId"]},unpinMessage:{label:"unpin",detailKeys:["channelId","messageId"]},listPins:{label:"list pins",detailKeys:["channelId"]},searchMessages:{label:"search",detailKeys:["guildId","content"]},memberInfo:{label:"member",detailKeys:["guildId","userId"]},roleInfo:{label:"roles",detailKeys:["guildId"]},emojiList:{label:"emoji list",detailKeys:["guildId"]},roleAdd:{label:"role add",detailKeys:["guildId","userId","roleId"]},roleRemove:{label:"role remove",detailKeys:["guildId","userId","roleId"]},channelInfo:{label:"channel",detailKeys:["channelId"]},channelList:{label:"channels",detailKeys:["guildId"]},voiceStatus:{label:"voice",detailKeys:["guildId","userId"]},eventList:{label:"events",detailKeys:["guildId"]},eventCreate:{label:"event create",detailKeys:["guildId","name"]},timeout:{label:"timeout",detailKeys:["guildId","userId"]},kick:{label:"kick",detailKeys:["guildId","userId"]},ban:{label:"ban",detailKeys:["guildId","userId"]}}},slack:{emoji:"💬",title:"Slack",actions:{react:{label:"react",detailKeys:["channelId","messageId","emoji"]},reactions:{label:"reactions",detailKeys:["channelId","messageId"]},sendMessage:{label:"send",detailKeys:["to","content"]},editMessage:{label:"edit",detailKeys:["channelId","messageId"]},deleteMessage:{label:"delete",detailKeys:["channelId","messageId"]},readMessages:{label:"read messages",detailKeys:["channelId","limit"]},pinMessage:{label:"pin",detailKeys:["channelId","messageId"]},unpinMessage:{label:"unpin",detailKeys:["channelId","messageId"]},listPins:{label:"list pins",detailKeys:["channelId"]},memberInfo:{label:"member",detailKeys:["userId"]},emojiList:{label:"emoji list"}}}},Yu={fallback:Vu,tools:Gu},cr=Yu,Co=cr.fallback??{emoji:"🧩"},Qu=cr.tools??{};function Ju(e){return(e??"tool").trim()}function Zu(e){const t=e.replace(/_/g," ").trim();return t?t.split(/\s+/).map(n=>n.length<=2&&n.toUpperCase()===n?n:`${n.at(0)?.toUpperCase()??""}${n.slice(1)}`).join(" "):"Tool"}function Xu(e){const t=e?.trim();if(t)return t.replace(/_/g," ")}function dr(e){if(e!=null){if(typeof e=="string"){const t=e.trim();if(!t)return;const n=t.split(/\r?\n/)[0]?.trim()??"";return n?n.length>160?`${n.slice(0,157)}…`:n:void 0}if(typeof e=="number"||typeof e=="boolean")return String(e);if(Array.isArray(e)){const t=e.map(s=>dr(s)).filter(s=>!!s);if(t.length===0)return;const n=t.slice(0,3).join(", ");return t.length>3?`${n}…`:n}}}function ep(e,t){if(!e||typeof e!="object")return;let n=e;for(const s of t.split(".")){if(!s||!n||typeof n!="object")return;n=n[s]}return n}function tp(e,t){for(const n of t){const s=ep(e,n),i=dr(s);if(i)return i}}function np(e){if(!e||typeof e!="object")return;const t=e,n=typeof t.path=="string"?t.path:void 0;if(!n)return;const s=typeof t.offset=="number"?t.offset:void 0,i=typeof t.limit=="number"?t.limit:void 0;return s!==void 0&&i!==void 0?`${n}:${s}-${s+i}`:n}function sp(e){if(!e||typeof e!="object")return;const t=e;return typeof t.path=="string"?t.path:void 0}function ip(e,t){if(!(!e||!t))return e.actions?.[t]??void 0}function op(e){const t=Ju(e.name),n=t.toLowerCase(),s=Qu[n],i=s?.emoji??Co.emoji??"🧩",o=s?.title??Zu(t),a=s?.label??t,l=e.args&&typeof e.args=="object"?e.args.action:void 0,r=typeof l=="string"?l.trim():void 0,p=ip(s,r),d=Xu(p?.label??r);let u;n==="read"&&(u=np(e.args)),!u&&(n==="write"||n==="edit"||n==="attach")&&(u=sp(e.args));const h=p?.detailKeys??s?.detailKeys??Co.detailKeys??[];return!u&&h.length>0&&(u=tp(e.args,h)),!u&&e.meta&&(u=e.meta),u&&(u=rp(u)),{name:t,emoji:i,title:o,label:a,verb:d,detail:u}}function ap(e){const t=[];if(e.verb&&t.push(e.verb),e.detail&&t.push(e.detail),t.length!==0)return t.join(" · ")}function rp(e){return e&&e.replace(/\/Users\/[^/]+/g,"~").replace(/\/home\/[^/]+/g,"~")}const lp=80,cp=2,Eo=100;function dp(e){const t=e.trim();if(t.startsWith("{")||t.startsWith("["))try{const n=JSON.parse(t);return"```json\n"+JSON.stringify(n,null,2)+"\n```"}catch{}return e}function up(e){const t=e.split(`
`),n=t.slice(0,cp),s=n.join(`
`);return s.length>Eo?s.slice(0,Eo)+"…":n.length<t.length?s+"…":s}function pp(e){const t=e,n=fp(t.content),s=[];for(const i of n){const o=String(i.type??"").toLowerCase();(["toolcall","tool_call","tooluse","tool_use"].includes(o)||typeof i.name=="string"&&i.arguments!=null)&&s.push({kind:"call",name:i.name??"tool",args:hp(i.arguments??i.args)})}for(const i of n){const o=String(i.type??"").toLowerCase();if(o!=="toolresult"&&o!=="tool_result")continue;const a=gp(i),l=typeof i.name=="string"?i.name:"tool";s.push({kind:"result",name:l,text:a})}if(Wa(e)&&!s.some(i=>i.kind==="result")){const i=typeof t.toolName=="string"&&t.toolName||typeof t.tool_name=="string"&&t.tool_name||"tool",o=ca(e)??void 0;s.push({kind:"result",name:i,text:o})}return s}function Io(e,t){const n=op({name:e.name,args:e.args}),s=ap(n),i=!!e.text?.trim(),o=!!t,a=o?()=>{if(i){t(dp(e.text));return}const u=`## ${n.label}

${s?`**Command:** \`${s}\`

`:""}*No output — tool completed successfully.*`;t(u)}:void 0,l=i&&(e.text?.length??0)<=lp,r=i&&!l,p=i&&l,d=!i;return c`
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
        ${o?c`<span class="chat-tool-card__action">${i?"View ›":"›"}</span>`:g}
        ${d&&!o?c`<span class="chat-tool-card__status">✓</span>`:g}
      </div>
      ${s?c`<div class="chat-tool-card__detail">${s}</div>`:g}
      ${d?c`<div class="chat-tool-card__status-text muted">Completed</div>`:g}
      ${r?c`<div class="chat-tool-card__preview mono">${up(e.text)}</div>`:g}
      ${p?c`<div class="chat-tool-card__inline mono">${e.text}</div>`:g}
    </div>
  `}function fp(e){return Array.isArray(e)?e.filter(Boolean):[]}function hp(e){if(typeof e!="string")return e;const t=e.trim();if(!t||!t.startsWith("{")&&!t.startsWith("["))return e;try{return JSON.parse(t)}catch{return e}}function gp(e){if(typeof e.text=="string")return e.text;if(typeof e.content=="string")return e.content}function vp(e){return c`
    <div class="chat-group assistant">
      ${ci("assistant",e)}
      <div class="chat-group-messages">
        <div class="chat-bubble chat-reading-indicator" aria-hidden="true">
          <span class="chat-reading-indicator__dots">
            <span></span><span></span><span></span>
          </span>
        </div>
      </div>
    </div>
  `}function mp(e,t,n,s){const i=new Date(t).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"}),o=s?.name??"Assistant";return c`
    <div class="chat-group assistant">
      ${ci("assistant",s)}
      <div class="chat-group-messages">
        ${ur({role:"assistant",content:[{type:"text",text:e}],timestamp:t},{isStreaming:!0,showReasoning:!1},n)}
        <div class="chat-group-footer">
          <span class="chat-sender-name">${o}</span>
          <span class="chat-group-timestamp">${i}</span>
        </div>
      </div>
    </div>
  `}function bp(e,t){const n=Xs(e.role),s=t.assistantName??"Assistant",i=n==="user"?"You":n==="assistant"?s:n,o=n==="user"?"user":n==="assistant"?"assistant":"other",a=new Date(e.timestamp).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});return c`
    <div class="chat-group ${o}">
      ${ci(e.role,{name:s,avatar:t.assistantAvatar??null})}
      <div class="chat-group-messages">
        ${e.messages.map((l,r)=>ur(l.message,{isStreaming:e.isStreaming&&r===e.messages.length-1,showReasoning:t.showReasoning},t.onOpenSidebar))}
        <div class="chat-group-footer">
          <span class="chat-sender-name">${i}</span>
          <span class="chat-group-timestamp">${a}</span>
        </div>
      </div>
    </div>
  `}function ci(e,t){const n=Xs(e),s=t?.name?.trim()||"Assistant",i=t?.avatar?.trim()||"",o=n==="user"?"U":n==="assistant"?s.charAt(0).toUpperCase()||"A":n==="tool"?"⚙":"?",a=n==="user"?"user":n==="assistant"?"assistant":n==="tool"?"tool":"other";return i&&n==="assistant"?yp(i)?c`<img
        class="chat-avatar ${a}"
        src="${i}"
        alt="${s}"
      />`:c`<div class="chat-avatar ${a}">${i}</div>`:c`<div class="chat-avatar ${a}">${o}</div>`}function yp(e){return/^https?:\/\//i.test(e)||/^data:image\//i.test(e)||/^\//.test(e)}function ur(e,t,n){const s=e,i=typeof s.role=="string"?s.role:"unknown",o=Wa(e)||i.toLowerCase()==="toolresult"||i.toLowerCase()==="tool_result"||typeof s.toolCallId=="string"||typeof s.tool_call_id=="string",a=pp(e),l=a.length>0,r=ca(e),p=t.showReasoning&&i==="assistant"?xl(e):null,d=r?.trim()?r:null,u=p?Sl(p):null,h=d,v=i==="assistant"&&!!h?.trim(),w=["chat-bubble",v?"has-copy":"",t.isStreaming?"streaming":"","fade-in"].filter(Boolean).join(" ");return!h&&l&&o?c`${a.map($=>Io($,n))}`:!h&&!l?g:c`
    <div class="${w}">
      ${v?Wu(h):g}
      ${u?c`<div class="chat-thinking">${vs(As(u))}</div>`:g}
      ${h?c`<div class="chat-text">${vs(As(h))}</div>`:g}
      ${a.map($=>Io($,n))}
    </div>
  `}function wp(e){return c`
    <div class="sidebar-panel">
      <div class="sidebar-header">
        <div class="sidebar-title">Tool Output</div>
        <button @click=${e.onClose} class="btn" title="Close sidebar">
          ✕
        </button>
      </div>
      <div class="sidebar-content">
        ${e.error?c`
              <div class="callout danger">${e.error}</div>
              <button @click=${e.onViewRawText} class="btn" style="margin-top: 12px;">
                View Raw Text
              </button>
            `:e.content?c`<div class="sidebar-markdown">${vs(As(e.content))}</div>`:c`<div class="muted">No content available</div>`}
      </div>
    </div>
  `}var $p=Object.defineProperty,kp=Object.getOwnPropertyDescriptor,vn=(e,t,n,s)=>{for(var i=s>1?void 0:s?kp(t,n):t,o=e.length-1,a;o>=0;o--)(a=e[o])&&(i=(s?a(t,n,i):a(i))||i);return s&&i&&$p(t,n,i),i};let tt=class extends Qe{constructor(){super(...arguments),this.splitRatio=.6,this.minRatio=.4,this.maxRatio=.7,this.isDragging=!1,this.startX=0,this.startRatio=0,this.handleMouseDown=e=>{this.isDragging=!0,this.startX=e.clientX,this.startRatio=this.splitRatio,this.classList.add("dragging"),document.addEventListener("mousemove",this.handleMouseMove),document.addEventListener("mouseup",this.handleMouseUp),e.preventDefault()},this.handleMouseMove=e=>{if(!this.isDragging)return;const t=this.parentElement;if(!t)return;const n=t.getBoundingClientRect().width,i=(e.clientX-this.startX)/n;let o=this.startRatio+i;o=Math.max(this.minRatio,Math.min(this.maxRatio,o)),this.dispatchEvent(new CustomEvent("resize",{detail:{splitRatio:o},bubbles:!0,composed:!0}))},this.handleMouseUp=()=>{this.isDragging=!1,this.classList.remove("dragging"),document.removeEventListener("mousemove",this.handleMouseMove),document.removeEventListener("mouseup",this.handleMouseUp)}}render(){return c``}connectedCallback(){super.connectedCallback(),this.addEventListener("mousedown",this.handleMouseDown)}disconnectedCallback(){super.disconnectedCallback(),this.removeEventListener("mousedown",this.handleMouseDown),document.removeEventListener("mousemove",this.handleMouseMove),document.removeEventListener("mouseup",this.handleMouseUp)}};tt.styles=Fr`
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
  `;vn([on({type:Number})],tt.prototype,"splitRatio",2);vn([on({type:Number})],tt.prototype,"minRatio",2);vn([on({type:Number})],tt.prototype,"maxRatio",2);tt=vn([ta("resizable-divider")],tt);const xp=5e3;function Ap(e){return e?e.active?c`
      <div class="callout info compaction-indicator compaction-indicator--active">
        🧹 Compacting context...
      </div>
    `:e.completedAt&&Date.now()-e.completedAt<xp?c`
        <div class="callout success compaction-indicator compaction-indicator--complete">
          🧹 Context compacted
        </div>
      `:g:g}function Sp(e){const t=e.connected,n=e.sending||e.stream!==null,i=e.sessions?.sessions?.find(u=>u.key===e.sessionKey)?.reasoningLevel??"off",o=e.showThinking&&i!=="off",a={name:e.assistantName,avatar:e.assistantAvatar??e.assistantAvatarUrl??null},l=e.connected?"Message (↩ to send, Shift+↩ for line breaks)":"Connect to the gateway to start chatting…",r=e.splitRatio??.6,p=!!(e.sidebarOpen&&e.onCloseSidebar),d=c`
    <div
      class="chat-thread"
      role="log"
      aria-live="polite"
      @scroll=${e.onChatScroll}
    >
      ${e.loading?c`<div class="muted">Loading chat…</div>`:g}
      ${ja(Tp(e),u=>u.key,u=>u.kind==="reading-indicator"?vp(a):u.kind==="stream"?mp(u.text,u.startedAt,e.onOpenSidebar,a):u.kind==="group"?bp(u,{onOpenSidebar:e.onOpenSidebar,showReasoning:o,assistantName:e.assistantName,assistantAvatar:a.avatar}):g)}
    </div>
  `;return c`
    <section class="card chat">
      ${e.disabledReason?c`<div class="callout">${e.disabledReason}</div>`:g}

      ${e.error?c`<div class="callout danger">${e.error}</div>`:g}

      ${Ap(e.compactionStatus)}

      ${e.focusMode?c`
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
          ${d}
        </div>

        ${p?c`
              <resizable-divider
                .splitRatio=${r}
                @resize=${u=>e.onSplitRatioChange?.(u.detail.splitRatio)}
              ></resizable-divider>
              <div class="chat-sidebar">
                ${wp({content:e.sidebarContent??null,error:e.sidebarError??null,onClose:e.onCloseSidebar,onViewRawText:()=>{!e.sidebarContent||!e.onOpenSidebar||e.onOpenSidebar(`\`\`\`
${e.sidebarContent}
\`\`\``)}})}
              </div>
            `:g}
      </div>

      ${e.queue.length?c`
            <div class="chat-queue" role="status" aria-live="polite">
              <div class="chat-queue__title">Queued (${e.queue.length})</div>
              <div class="chat-queue__list">
                ${e.queue.map(u=>c`
                    <div class="chat-queue__item">
                      <div class="chat-queue__text">${u.text}</div>
                      <button
                        class="btn chat-queue__remove"
                        type="button"
                        aria-label="Remove queued message"
                        @click=${()=>e.onQueueRemove(u.id)}
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
            @keydown=${u=>{u.key==="Enter"&&(u.isComposing||u.keyCode===229||u.shiftKey||e.connected&&(u.preventDefault(),t&&e.onSend()))}}
            @input=${u=>e.onDraftChange(u.target.value)}
            placeholder=${l}
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
  `}const Lo=200;function _p(e){const t=[];let n=null;for(const s of e){if(s.kind!=="message"){n&&(t.push(n),n=null),t.push(s);continue}const i=qa(s.message),o=Xs(i.role),a=i.timestamp||Date.now();!n||n.role!==o?(n&&t.push(n),n={kind:"group",key:`group:${o}:${s.key}`,role:o,messages:[{message:s.message,key:s.key}],timestamp:a,isStreaming:!1}):n.messages.push({message:s.message,key:s.key})}return n&&t.push(n),t}function Tp(e){const t=[],n=Array.isArray(e.messages)?e.messages:[],s=Array.isArray(e.toolMessages)?e.toolMessages:[],i=Math.max(0,n.length-Lo);i>0&&t.push({kind:"message",key:"chat:history:notice",message:{role:"system",content:`Showing last ${Lo} messages (${i} hidden).`,timestamp:Date.now()}});for(let o=i;o<n.length;o++){const a=n[o],l=qa(a);!e.showThinking&&l.role.toLowerCase()==="toolresult"||t.push({kind:"message",key:Ro(a,o),message:a})}if(e.showThinking)for(let o=0;o<s.length;o++)t.push({kind:"message",key:Ro(s[o],o+n.length),message:s[o]});if(e.stream!==null){const o=`stream:${e.sessionKey}:${e.streamStartedAt??"live"}`;e.stream.trim().length>0?t.push({kind:"stream",key:o,text:e.stream,startedAt:e.streamStartedAt??Date.now()}):t.push({kind:"reading-indicator",key:o})}return _p(t)}function Ro(e,t){const n=e,s=typeof n.toolCallId=="string"?n.toolCallId:"";if(s)return`tool:${s}`;const i=typeof n.id=="string"?n.id:"";if(i)return`msg:${i}`;const o=typeof n.messageId=="string"?n.messageId:"";if(o)return`msg:${o}`;const a=typeof n.timestamp=="number"?n.timestamp:null,l=typeof n.role=="string"?n.role:"unknown";return a!=null?`msg:${l}:${a}:${t}`:`msg:${l}:${t}`}function de(e){if(e)return Array.isArray(e.type)?e.type.filter(n=>n!=="null")[0]??e.type[0]:e.type}function pr(e){if(!e)return"";if(e.default!==void 0)return e.default;switch(de(e)){case"object":return{};case"array":return[];case"boolean":return!1;case"number":case"integer":return 0;case"string":return"";default:return""}}function mn(e){return e.filter(t=>typeof t=="string").join(".")}function ee(e,t){const n=mn(e),s=t[n];if(s)return s;const i=n.split(".");for(const[o,a]of Object.entries(t)){if(!o.includes("*"))continue;const l=o.split(".");if(l.length!==i.length)continue;let r=!0;for(let p=0;p<i.length;p+=1)if(l[p]!=="*"&&l[p]!==i[p]){r=!1;break}if(r)return a}}function ye(e){return e.replace(/_/g," ").replace(/([a-z0-9])([A-Z])/g,"$1 $2").replace(/\s+/g," ").replace(/^./,t=>t.toUpperCase())}function Cp(e){const t=mn(e).toLowerCase();return t.includes("token")||t.includes("password")||t.includes("secret")||t.includes("apikey")||t.endsWith("key")}const Ep=new Set(["title","description","default","nullable"]);function Ip(e){return Object.keys(e??{}).filter(n=>!Ep.has(n)).length===0}function Lp(e){if(e===void 0)return"";try{return JSON.stringify(e,null,2)??""}catch{return""}}const St={chevronDown:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`,plus:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,minus:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,trash:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`,edit:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`};function be(e){const{schema:t,value:n,path:s,hints:i,unsupported:o,disabled:a,onPatch:l}=e,r=e.showLabel??!0,p=de(t),d=ee(s,i),u=d?.label??t.title??ye(String(s.at(-1))),h=d?.help??t.description,v=mn(s);if(o.has(v))return c`<div class="cfg-field cfg-field--error">
      <div class="cfg-field__label">${u}</div>
      <div class="cfg-field__error">Unsupported schema node. Use Raw mode.</div>
    </div>`;if(t.anyOf||t.oneOf){const $=(t.anyOf??t.oneOf??[]).filter(A=>!(A.type==="null"||Array.isArray(A.type)&&A.type.includes("null")));if($.length===1)return be({...e,schema:$[0]});const x=A=>{if(A.const!==void 0)return A.const;if(A.enum&&A.enum.length===1)return A.enum[0]},C=$.map(x),I=C.every(A=>A!==void 0);if(I&&C.length>0&&C.length<=5){const A=n??t.default;return c`
        <div class="cfg-field">
          ${r?c`<label class="cfg-field__label">${u}</label>`:g}
          ${h?c`<div class="cfg-field__help">${h}</div>`:g}
          <div class="cfg-segmented">
            ${C.map((B,ue)=>c`
              <button
                type="button"
                class="cfg-segmented__btn ${B===A||String(B)===String(A)?"active":""}"
                ?disabled=${a}
                @click=${()=>l(s,B)}
              >
                ${String(B)}
              </button>
            `)}
          </div>
        </div>
      `}if(I&&C.length>5)return Po({...e,options:C,value:n??t.default});const R=new Set($.map(A=>de(A)).filter(Boolean)),E=new Set([...R].map(A=>A==="integer"?"number":A));if([...E].every(A=>["string","number","boolean"].includes(A))){const A=E.has("string"),B=E.has("number");if(E.has("boolean")&&E.size===1)return be({...e,schema:{...t,type:"boolean",anyOf:void 0,oneOf:void 0}});if(A||B)return Mo({...e,inputType:B&&!A?"number":"text"})}}if(t.enum){const w=t.enum;if(w.length<=5){const $=n??t.default;return c`
        <div class="cfg-field">
          ${r?c`<label class="cfg-field__label">${u}</label>`:g}
          ${h?c`<div class="cfg-field__help">${h}</div>`:g}
          <div class="cfg-segmented">
            ${w.map(x=>c`
              <button
                type="button"
                class="cfg-segmented__btn ${x===$||String(x)===String($)?"active":""}"
                ?disabled=${a}
                @click=${()=>l(s,x)}
              >
                ${String(x)}
              </button>
            `)}
          </div>
        </div>
      `}return Po({...e,options:w,value:n??t.default})}if(p==="object")return Mp(e);if(p==="array")return Pp(e);if(p==="boolean"){const w=typeof n=="boolean"?n:typeof t.default=="boolean"?t.default:!1;return c`
      <label class="cfg-toggle-row ${a?"disabled":""}">
        <div class="cfg-toggle-row__content">
          <span class="cfg-toggle-row__label">${u}</span>
          ${h?c`<span class="cfg-toggle-row__help">${h}</span>`:g}
        </div>
        <div class="cfg-toggle">
          <input
            type="checkbox"
            .checked=${w}
            ?disabled=${a}
            @change=${$=>l(s,$.target.checked)}
          />
          <span class="cfg-toggle__track"></span>
        </div>
      </label>
    `}return p==="number"||p==="integer"?Rp(e):p==="string"?Mo({...e,inputType:"text"}):c`
    <div class="cfg-field cfg-field--error">
      <div class="cfg-field__label">${u}</div>
      <div class="cfg-field__error">Unsupported type: ${p}. Use Raw mode.</div>
    </div>
  `}function Mo(e){const{schema:t,value:n,path:s,hints:i,disabled:o,onPatch:a,inputType:l}=e,r=e.showLabel??!0,p=ee(s,i),d=p?.label??t.title??ye(String(s.at(-1))),u=p?.help??t.description,h=p?.sensitive??Cp(s),v=p?.placeholder??(h?"••••":t.default!==void 0?`Default: ${t.default}`:""),w=n??"";return c`
    <div class="cfg-field">
      ${r?c`<label class="cfg-field__label">${d}</label>`:g}
      ${u?c`<div class="cfg-field__help">${u}</div>`:g}
      <div class="cfg-input-wrap">
        <input
          type=${h?"password":l}
          class="cfg-input"
          placeholder=${v}
          .value=${w==null?"":String(w)}
          ?disabled=${o}
          @input=${$=>{const x=$.target.value;if(l==="number"){if(x.trim()===""){a(s,void 0);return}const C=Number(x);a(s,Number.isNaN(C)?x:C);return}a(s,x)}}
        />
        ${t.default!==void 0?c`
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
  `}function Rp(e){const{schema:t,value:n,path:s,hints:i,disabled:o,onPatch:a}=e,l=e.showLabel??!0,r=ee(s,i),p=r?.label??t.title??ye(String(s.at(-1))),d=r?.help??t.description,u=n??t.default??"",h=typeof u=="number"?u:0;return c`
    <div class="cfg-field">
      ${l?c`<label class="cfg-field__label">${p}</label>`:g}
      ${d?c`<div class="cfg-field__help">${d}</div>`:g}
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
  `}function Po(e){const{schema:t,value:n,path:s,hints:i,disabled:o,options:a,onPatch:l}=e,r=e.showLabel??!0,p=ee(s,i),d=p?.label??t.title??ye(String(s.at(-1))),u=p?.help??t.description,h=n??t.default,v=a.findIndex($=>$===h||String($)===String(h)),w="__unset__";return c`
    <div class="cfg-field">
      ${r?c`<label class="cfg-field__label">${d}</label>`:g}
      ${u?c`<div class="cfg-field__help">${u}</div>`:g}
      <select
        class="cfg-select"
        ?disabled=${o}
        .value=${v>=0?String(v):w}
        @change=${$=>{const x=$.target.value;l(s,x===w?void 0:a[Number(x)])}}
      >
        <option value=${w}>Select...</option>
        ${a.map(($,x)=>c`
          <option value=${String(x)}>${String($)}</option>
        `)}
      </select>
    </div>
  `}function Mp(e){const{schema:t,value:n,path:s,hints:i,unsupported:o,disabled:a,onPatch:l}=e;e.showLabel;const r=ee(s,i),p=r?.label??t.title??ye(String(s.at(-1))),d=r?.help??t.description,u=n??t.default,h=u&&typeof u=="object"&&!Array.isArray(u)?u:{},v=t.properties??{},$=Object.entries(v).sort((R,E)=>{const A=ee([...s,R[0]],i)?.order??0,B=ee([...s,E[0]],i)?.order??0;return A!==B?A-B:R[0].localeCompare(E[0])}),x=new Set(Object.keys(v)),C=t.additionalProperties,I=!!C&&typeof C=="object";return s.length===1?c`
      <div class="cfg-fields">
        ${$.map(([R,E])=>be({schema:E,value:h[R],path:[...s,R],hints:i,unsupported:o,disabled:a,onPatch:l}))}
        ${I?No({schema:C,value:h,path:s,hints:i,unsupported:o,disabled:a,reservedKeys:x,onPatch:l}):g}
      </div>
    `:c`
    <details class="cfg-object" open>
      <summary class="cfg-object__header">
        <span class="cfg-object__title">${p}</span>
        <span class="cfg-object__chevron">${St.chevronDown}</span>
      </summary>
      ${d?c`<div class="cfg-object__help">${d}</div>`:g}
      <div class="cfg-object__content">
        ${$.map(([R,E])=>be({schema:E,value:h[R],path:[...s,R],hints:i,unsupported:o,disabled:a,onPatch:l}))}
        ${I?No({schema:C,value:h,path:s,hints:i,unsupported:o,disabled:a,reservedKeys:x,onPatch:l}):g}
      </div>
    </details>
  `}function Pp(e){const{schema:t,value:n,path:s,hints:i,unsupported:o,disabled:a,onPatch:l}=e,r=e.showLabel??!0,p=ee(s,i),d=p?.label??t.title??ye(String(s.at(-1))),u=p?.help??t.description,h=Array.isArray(t.items)?t.items[0]:t.items;if(!h)return c`
      <div class="cfg-field cfg-field--error">
        <div class="cfg-field__label">${d}</div>
        <div class="cfg-field__error">Unsupported array schema. Use Raw mode.</div>
      </div>
    `;const v=Array.isArray(n)?n:Array.isArray(t.default)?t.default:[];return c`
    <div class="cfg-array">
      <div class="cfg-array__header">
        ${r?c`<span class="cfg-array__label">${d}</span>`:g}
        <span class="cfg-array__count">${v.length} item${v.length!==1?"s":""}</span>
        <button
          type="button"
          class="cfg-array__add"
          ?disabled=${a}
          @click=${()=>{const w=[...v,pr(h)];l(s,w)}}
        >
          <span class="cfg-array__add-icon">${St.plus}</span>
          Add
        </button>
      </div>
      ${u?c`<div class="cfg-array__help">${u}</div>`:g}
      
      ${v.length===0?c`
        <div class="cfg-array__empty">
          No items yet. Click "Add" to create one.
        </div>
      `:c`
        <div class="cfg-array__items">
          ${v.map((w,$)=>c`
            <div class="cfg-array__item">
              <div class="cfg-array__item-header">
                <span class="cfg-array__item-index">#${$+1}</span>
                <button
                  type="button"
                  class="cfg-array__item-remove"
                  title="Remove item"
                  ?disabled=${a}
                  @click=${()=>{const x=[...v];x.splice($,1),l(s,x)}}
                >
                  ${St.trash}
                </button>
              </div>
              <div class="cfg-array__item-content">
                ${be({schema:h,value:w,path:[...s,$],hints:i,unsupported:o,disabled:a,showLabel:!1,onPatch:l})}
              </div>
            </div>
          `)}
        </div>
      `}
    </div>
  `}function No(e){const{schema:t,value:n,path:s,hints:i,unsupported:o,disabled:a,reservedKeys:l,onPatch:r}=e,p=Ip(t),d=Object.entries(n??{}).filter(([u])=>!l.has(u));return c`
    <div class="cfg-map">
      <div class="cfg-map__header">
        <span class="cfg-map__label">Custom entries</span>
        <button
          type="button"
          class="cfg-map__add"
          ?disabled=${a}
          @click=${()=>{const u={...n??{}};let h=1,v=`custom-${h}`;for(;v in u;)h+=1,v=`custom-${h}`;u[v]=p?{}:pr(t),r(s,u)}}
        >
          <span class="cfg-map__add-icon">${St.plus}</span>
          Add Entry
        </button>
      </div>
      
      ${d.length===0?c`
        <div class="cfg-map__empty">No custom entries.</div>
      `:c`
        <div class="cfg-map__items">
          ${d.map(([u,h])=>{const v=[...s,u],w=Lp(h);return c`
              <div class="cfg-map__item">
                <div class="cfg-map__item-key">
                  <input
                    type="text"
                    class="cfg-input cfg-input--sm"
                    placeholder="Key"
                    .value=${u}
                    ?disabled=${a}
                    @change=${$=>{const x=$.target.value.trim();if(!x||x===u)return;const C={...n??{}};x in C||(C[x]=C[u],delete C[u],r(s,C))}}
                  />
                </div>
                <div class="cfg-map__item-value">
                  ${p?c`
                        <textarea
                          class="cfg-textarea cfg-textarea--sm"
                          placeholder="JSON value"
                          rows="2"
                          .value=${w}
                          ?disabled=${a}
                          @change=${$=>{const x=$.target,C=x.value.trim();if(!C){r(v,void 0);return}try{r(v,JSON.parse(C))}catch{x.value=w}}}
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
                  ${St.trash}
                </button>
              </div>
            `})}
        </div>
      `}
    </div>
  `}const Oo={env:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,update:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`,agents:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"></path><circle cx="8" cy="14" r="1"></circle><circle cx="16" cy="14" r="1"></circle></svg>`,auth:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`,channels:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`,messages:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>`,commands:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`,hooks:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>`,skills:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`,tools:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>`,gateway:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`,wizard:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M15 4V2"></path><path d="M15 16v-2"></path><path d="M8 9h2"></path><path d="M20 9h2"></path><path d="M17.8 11.8 19 13"></path><path d="M15 9h0"></path><path d="M17.8 6.2 19 5"></path><path d="m3 21 9-9"></path><path d="M12.2 6.2 11 5"></path></svg>`,meta:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>`,logging:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>`,browser:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="4"></circle><line x1="21.17" y1="8" x2="12" y2="8"></line><line x1="3.95" y1="6.06" x2="8.54" y2="14"></line><line x1="10.88" y1="21.94" x2="15.46" y2="14"></line></svg>`,ui:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>`,models:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>`,bindings:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>`,broadcast:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"></path><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"></path><circle cx="12" cy="12" r="2"></circle><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"></path><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"></path></svg>`,audio:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`,session:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`,cron:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`,web:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`,discovery:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,canvasHost:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`,talk:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`,plugins:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2v6"></path><path d="m4.93 10.93 4.24 4.24"></path><path d="M2 12h6"></path><path d="m4.93 13.07 4.24-4.24"></path><path d="M12 22v-6"></path><path d="m19.07 13.07-4.24-4.24"></path><path d="M22 12h-6"></path><path d="m19.07 10.93-4.24 4.24"></path></svg>`,default:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`},di={env:{label:"Environment Variables",description:"Environment variables passed to the gateway process"},update:{label:"Updates",description:"Auto-update settings and release channel"},agents:{label:"Agents",description:"Agent configurations, models, and identities"},auth:{label:"Authentication",description:"API keys and authentication profiles"},channels:{label:"Channels",description:"Messaging channels (Telegram, Discord, Slack, etc.)"},messages:{label:"Messages",description:"Message handling and routing settings"},commands:{label:"Commands",description:"Custom slash commands"},hooks:{label:"Hooks",description:"Webhooks and event hooks"},skills:{label:"Skills",description:"Skill packs and capabilities"},tools:{label:"Tools",description:"Tool configurations (browser, search, etc.)"},gateway:{label:"Gateway",description:"Gateway server settings (port, auth, binding)"},wizard:{label:"Setup Wizard",description:"Setup wizard state and history"},meta:{label:"Metadata",description:"Gateway metadata and version information"},logging:{label:"Logging",description:"Log levels and output configuration"},browser:{label:"Browser",description:"Browser automation settings"},ui:{label:"UI",description:"User interface preferences"},models:{label:"Models",description:"AI model configurations and providers"},bindings:{label:"Bindings",description:"Key bindings and shortcuts"},broadcast:{label:"Broadcast",description:"Broadcast and notification settings"},audio:{label:"Audio",description:"Audio input/output settings"},session:{label:"Session",description:"Session management and persistence"},cron:{label:"Cron",description:"Scheduled tasks and automation"},web:{label:"Web",description:"Web server and API settings"},discovery:{label:"Discovery",description:"Service discovery and networking"},canvasHost:{label:"Canvas Host",description:"Canvas rendering and display"},talk:{label:"Talk",description:"Voice and speech settings"},plugins:{label:"Plugins",description:"Plugin management and extensions"}};function Do(e){return Oo[e]??Oo.default}function Np(e,t,n){if(!n)return!0;const s=n.toLowerCase(),i=di[e];return e.toLowerCase().includes(s)||i&&(i.label.toLowerCase().includes(s)||i.description.toLowerCase().includes(s))?!0:vt(t,s)}function vt(e,t){if(e.title?.toLowerCase().includes(t)||e.description?.toLowerCase().includes(t)||e.enum?.some(s=>String(s).toLowerCase().includes(t)))return!0;if(e.properties){for(const[s,i]of Object.entries(e.properties))if(s.toLowerCase().includes(t)||vt(i,t))return!0}if(e.items){const s=Array.isArray(e.items)?e.items:[e.items];for(const i of s)if(i&&vt(i,t))return!0}if(e.additionalProperties&&typeof e.additionalProperties=="object"&&vt(e.additionalProperties,t))return!0;const n=e.anyOf??e.oneOf??e.allOf;if(n){for(const s of n)if(s&&vt(s,t))return!0}return!1}function Op(e){if(!e.schema)return c`<div class="muted">Schema unavailable.</div>`;const t=e.schema,n=e.value??{};if(de(t)!=="object"||!t.properties)return c`<div class="callout danger">Unsupported schema. Use Raw.</div>`;const s=new Set(e.unsupportedPaths??[]),i=t.properties,o=e.searchQuery??"",a=e.activeSection,l=e.activeSubsection??null,p=Object.entries(i).sort((u,h)=>{const v=ee([u[0]],e.uiHints)?.order??50,w=ee([h[0]],e.uiHints)?.order??50;return v!==w?v-w:u[0].localeCompare(h[0])}).filter(([u,h])=>!(a&&u!==a||o&&!Np(u,h,o)));let d=null;if(a&&l&&p.length===1){const u=p[0]?.[1];u&&de(u)==="object"&&u.properties&&u.properties[l]&&(d={sectionKey:a,subsectionKey:l,schema:u.properties[l]})}return p.length===0?c`
      <div class="config-empty">
        <div class="config-empty__icon">🔍</div>
        <div class="config-empty__text">
          ${o?`No settings match "${o}"`:"No settings in this section"}
        </div>
      </div>
    `:c`
    <div class="config-form config-form--modern">
      ${d?(()=>{const{sectionKey:u,subsectionKey:h,schema:v}=d,w=ee([u,h],e.uiHints),$=w?.label??v.title??ye(h),x=w?.help??v.description??"",C=n[u],I=C&&typeof C=="object"?C[h]:void 0,R=`config-section-${u}-${h}`;return c`
              <section class="config-section-card" id=${R}>
                <div class="config-section-card__header">
                  <span class="config-section-card__icon">${Do(u)}</span>
                  <div class="config-section-card__titles">
                    <h3 class="config-section-card__title">${$}</h3>
                    ${x?c`<p class="config-section-card__desc">${x}</p>`:g}
                  </div>
                </div>
                <div class="config-section-card__content">
                  ${be({schema:v,value:I,path:[u,h],hints:e.uiHints,unsupported:s,disabled:e.disabled??!1,showLabel:!1,onPatch:e.onPatch})}
                </div>
              </section>
            `})():p.map(([u,h])=>{const v=di[u]??{label:u.charAt(0).toUpperCase()+u.slice(1),description:h.description??""};return c`
              <section class="config-section-card" id="config-section-${u}">
                <div class="config-section-card__header">
                  <span class="config-section-card__icon">${Do(u)}</span>
                  <div class="config-section-card__titles">
                    <h3 class="config-section-card__title">${v.label}</h3>
                    ${v.description?c`<p class="config-section-card__desc">${v.description}</p>`:g}
                  </div>
                </div>
                <div class="config-section-card__content">
                  ${be({schema:h,value:n[u],path:[u],hints:e.uiHints,unsupported:s,disabled:e.disabled??!1,showLabel:!1,onPatch:e.onPatch})}
                </div>
              </section>
            `})}
    </div>
  `}const Dp=new Set(["title","description","default","nullable"]);function Bp(e){return Object.keys(e??{}).filter(n=>!Dp.has(n)).length===0}function fr(e){const t=e.filter(i=>i!=null),n=t.length!==e.length,s=[];for(const i of t)s.some(o=>Object.is(o,i))||s.push(i);return{enumValues:s,nullable:n}}function hr(e){return!e||typeof e!="object"?{schema:null,unsupportedPaths:["<root>"]}:yt(e,[])}function yt(e,t){const n=new Set,s={...e},i=mn(t)||"<root>";if(e.anyOf||e.oneOf||e.allOf){const l=Fp(e,t);return l||{schema:e,unsupportedPaths:[i]}}const o=Array.isArray(e.type)&&e.type.includes("null"),a=de(e)??(e.properties||e.additionalProperties?"object":void 0);if(s.type=a??e.type,s.nullable=o||e.nullable,s.enum){const{enumValues:l,nullable:r}=fr(s.enum);s.enum=l,r&&(s.nullable=!0),l.length===0&&n.add(i)}if(a==="object"){const l=e.properties??{},r={};for(const[p,d]of Object.entries(l)){const u=yt(d,[...t,p]);u.schema&&(r[p]=u.schema);for(const h of u.unsupportedPaths)n.add(h)}if(s.properties=r,e.additionalProperties===!0)n.add(i);else if(e.additionalProperties===!1)s.additionalProperties=!1;else if(e.additionalProperties&&typeof e.additionalProperties=="object"&&!Bp(e.additionalProperties)){const p=yt(e.additionalProperties,[...t,"*"]);s.additionalProperties=p.schema??e.additionalProperties,p.unsupportedPaths.length>0&&n.add(i)}}else if(a==="array"){const l=Array.isArray(e.items)?e.items[0]:e.items;if(!l)n.add(i);else{const r=yt(l,[...t,"*"]);s.items=r.schema??l,r.unsupportedPaths.length>0&&n.add(i)}}else a!=="string"&&a!=="number"&&a!=="integer"&&a!=="boolean"&&!s.enum&&n.add(i);return{schema:s,unsupportedPaths:Array.from(n)}}function Fp(e,t){if(e.allOf)return null;const n=e.anyOf??e.oneOf;if(!n)return null;const s=[],i=[];let o=!1;for(const l of n){if(!l||typeof l!="object")return null;if(Array.isArray(l.enum)){const{enumValues:r,nullable:p}=fr(l.enum);s.push(...r),p&&(o=!0);continue}if("const"in l){if(l.const==null){o=!0;continue}s.push(l.const);continue}if(de(l)==="null"){o=!0;continue}i.push(l)}if(s.length>0&&i.length===0){const l=[];for(const r of s)l.some(p=>Object.is(p,r))||l.push(r);return{schema:{...e,enum:l,nullable:o,anyOf:void 0,oneOf:void 0,allOf:void 0},unsupportedPaths:[]}}if(i.length===1){const l=yt(i[0],t);return l.schema&&(l.schema.nullable=o||l.schema.nullable),l}const a=["string","number","integer","boolean"];return i.length>0&&s.length===0&&i.every(l=>l.type&&a.includes(String(l.type)))?{schema:{...e,nullable:o},unsupportedPaths:[]}:null}const Ss={all:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>`,env:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,update:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`,agents:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"></path><circle cx="8" cy="14" r="1"></circle><circle cx="16" cy="14" r="1"></circle></svg>`,auth:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`,channels:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`,messages:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>`,commands:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`,hooks:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>`,skills:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`,tools:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>`,gateway:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`,wizard:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 4V2"></path><path d="M15 16v-2"></path><path d="M8 9h2"></path><path d="M20 9h2"></path><path d="M17.8 11.8 19 13"></path><path d="M15 9h0"></path><path d="M17.8 6.2 19 5"></path><path d="m3 21 9-9"></path><path d="M12.2 6.2 11 5"></path></svg>`,meta:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>`,logging:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>`,browser:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="4"></circle><line x1="21.17" y1="8" x2="12" y2="8"></line><line x1="3.95" y1="6.06" x2="8.54" y2="14"></line><line x1="10.88" y1="21.94" x2="15.46" y2="14"></line></svg>`,ui:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>`,models:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>`,bindings:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>`,broadcast:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"></path><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"></path><circle cx="12" cy="12" r="2"></circle><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"></path><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"></path></svg>`,audio:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`,session:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`,cron:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`,web:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`,discovery:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,canvasHost:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`,talk:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`,plugins:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v6"></path><path d="m4.93 10.93 4.24 4.24"></path><path d="M2 12h6"></path><path d="m4.93 13.07 4.24-4.24"></path><path d="M12 22v-6"></path><path d="m19.07 13.07-4.24-4.24"></path><path d="M22 12h-6"></path><path d="m19.07 10.93-4.24 4.24"></path></svg>`,default:c`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`},Bo=[{key:"env",label:"Environment"},{key:"update",label:"Updates"},{key:"agents",label:"Agents"},{key:"auth",label:"Authentication"},{key:"channels",label:"Channels"},{key:"messages",label:"Messages"},{key:"commands",label:"Commands"},{key:"hooks",label:"Hooks"},{key:"skills",label:"Skills"},{key:"tools",label:"Tools"},{key:"gateway",label:"Gateway"},{key:"wizard",label:"Setup Wizard"}],Fo="__all__";function Uo(e){return Ss[e]??Ss.default}function Up(e,t){const n=di[e];return n||{label:t?.title??ye(e),description:t?.description??""}}function Kp(e){const{key:t,schema:n,uiHints:s}=e;if(!n||de(n)!=="object"||!n.properties)return[];const i=Object.entries(n.properties).map(([o,a])=>{const l=ee([t,o],s),r=l?.label??a.title??ye(o),p=l?.help??a.description??"",d=l?.order??50;return{key:o,label:r,description:p,order:d}});return i.sort((o,a)=>o.order!==a.order?o.order-a.order:o.key.localeCompare(a.key)),i}function Hp(e,t){if(!e||!t)return[];const n=[];function s(i,o,a){if(i===o)return;if(typeof i!=typeof o){n.push({path:a,from:i,to:o});return}if(typeof i!="object"||i===null||o===null){i!==o&&n.push({path:a,from:i,to:o});return}if(Array.isArray(i)&&Array.isArray(o)){JSON.stringify(i)!==JSON.stringify(o)&&n.push({path:a,from:i,to:o});return}const l=i,r=o,p=new Set([...Object.keys(l),...Object.keys(r)]);for(const d of p)s(l[d],r[d],a?`${a}.${d}`:d)}return s(e,t,""),n}function Ko(e,t=40){let n;try{n=JSON.stringify(e)??String(e)}catch{n=String(e)}return n.length<=t?n:n.slice(0,t-3)+"..."}function zp(e){const t=e.valid==null?"unknown":e.valid?"valid":"invalid",n=hr(e.schema),s=n.schema?n.unsupportedPaths.length>0:!1,i=!!e.formValue&&!e.loading&&!s,o=e.connected&&!e.saving&&(e.formMode==="raw"?!0:i),a=e.connected&&!e.applying&&!e.updating&&(e.formMode==="raw"?!0:i),l=e.connected&&!e.applying&&!e.updating,r=n.schema?.properties??{},p=Bo.filter(A=>A.key in r),d=new Set(Bo.map(A=>A.key)),u=Object.keys(r).filter(A=>!d.has(A)).map(A=>({key:A,label:A.charAt(0).toUpperCase()+A.slice(1)})),h=[...p,...u],v=e.activeSection&&n.schema&&de(n.schema)==="object"?n.schema.properties?.[e.activeSection]:void 0,w=e.activeSection?Up(e.activeSection,v):null,$=e.activeSection?Kp({key:e.activeSection,schema:v,uiHints:e.uiHints}):[],x=e.formMode==="form"&&!!e.activeSection&&$.length>0,C=e.activeSubsection===Fo,I=e.searchQuery||C?null:e.activeSubsection??$[0]?.key??null,R=e.formMode==="form"?Hp(e.originalValue,e.formValue):[],E=R.length>0;return c`
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
          ${e.searchQuery?c`
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
            <span class="config-nav__icon">${Ss.all}</span>
            <span class="config-nav__label">All Settings</span>
          </button>
          ${h.map(A=>c`
            <button
              class="config-nav__item ${e.activeSection===A.key?"active":""}"
              @click=${()=>e.onSectionChange(A.key)}
            >
              <span class="config-nav__icon">${Uo(A.key)}</span>
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
            ${E?c`
              <span class="config-changes-badge">${R.length} unsaved change${R.length!==1?"s":""}</span>
            `:c`
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
              ?disabled=${!l}
              @click=${e.onUpdate}
            >
              ${e.updating?"Updating…":"Update"}
            </button>
          </div>
        </div>
        
        <!-- Diff panel -->
        ${E?c`
          <details class="config-diff">
            <summary class="config-diff__summary">
              <span>View ${R.length} pending change${R.length!==1?"s":""}</span>
              <svg class="config-diff__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </summary>
            <div class="config-diff__content">
              ${R.map(A=>c`
                <div class="config-diff__item">
                  <div class="config-diff__path">${A.path}</div>
                  <div class="config-diff__values">
                    <span class="config-diff__from">${Ko(A.from)}</span>
                    <span class="config-diff__arrow">→</span>
                    <span class="config-diff__to">${Ko(A.to)}</span>
                  </div>
                </div>
              `)}
            </div>
          </details>
        `:g}

        ${w&&e.formMode==="form"?c`
              <div class="config-section-hero">
                <div class="config-section-hero__icon">${Uo(e.activeSection??"")}</div>
                <div class="config-section-hero__text">
                  <div class="config-section-hero__title">${w.label}</div>
                  ${w.description?c`<div class="config-section-hero__desc">${w.description}</div>`:g}
                </div>
              </div>
            `:g}

        ${x?c`
              <div class="config-subnav">
                <button
                  class="config-subnav__item ${I===null?"active":""}"
                  @click=${()=>e.onSubsectionChange(Fo)}
                >
                  All
                </button>
                ${$.map(A=>c`
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
          ${e.formMode==="form"?c`
                ${e.schemaLoading?c`<div class="config-loading">
                      <div class="config-loading__spinner"></div>
                      <span>Loading schema…</span>
                    </div>`:Op({schema:n.schema,uiHints:e.uiHints,value:e.formValue,disabled:e.loading||!e.formValue,unsupportedPaths:n.unsupportedPaths,onPatch:e.onFormPatch,searchQuery:e.searchQuery,activeSection:e.activeSection,activeSubsection:I})}
                ${s?c`<div class="callout danger" style="margin-top: 12px;">
                      Form view can't safely edit some fields.
                      Use Raw to avoid losing config entries.
                    </div>`:g}
              `:c`
                <label class="field config-raw-field">
                  <span>Raw JSON5</span>
                  <textarea
                    .value=${e.raw}
                    @input=${A=>e.onRawChange(A.target.value)}
                  ></textarea>
                </label>
              `}
        </div>

        ${e.issues.length>0?c`<div class="callout danger" style="margin-top: 12px;">
              <pre class="code-block">${JSON.stringify(e.issues,null,2)}</pre>
            </div>`:g}
      </main>
    </div>
  `}function jp(e){if(!e&&e!==0)return"n/a";const t=Math.round(e/1e3);if(t<60)return`${t}s`;const n=Math.round(t/60);return n<60?`${n}m`:`${Math.round(n/60)}h`}function qp(e,t){const n=t.snapshot,s=n?.channels;if(!n||!s)return!1;const i=s[e],o=typeof i?.configured=="boolean"&&i.configured,a=typeof i?.running=="boolean"&&i.running,l=typeof i?.connected=="boolean"&&i.connected,p=(n.channelAccounts?.[e]??[]).some(d=>d.configured||d.running||d.connected);return o||a||l||p}function Wp(e,t){return t?.[e]?.length??0}function gr(e,t){const n=Wp(e,t);return n<2?g:c`<div class="account-count">Accounts (${n})</div>`}function Vp(e,t){let n=e;for(const s of t){if(!n)return null;const i=de(n);if(i==="object"){const o=n.properties??{};if(typeof s=="string"&&o[s]){n=o[s];continue}const a=n.additionalProperties;if(typeof s=="string"&&a&&typeof a=="object"){n=a;continue}return null}if(i==="array"){if(typeof s!="number")return null;n=(Array.isArray(n.items)?n.items[0]:n.items)??null;continue}return null}return n}function Gp(e,t){const s=(e.channels??{})[t],i=e[t];return(s&&typeof s=="object"?s:null)??(i&&typeof i=="object"?i:null)??{}}function Yp(e){const t=hr(e.schema),n=t.schema;if(!n)return c`<div class="callout danger">Schema unavailable. Use Raw.</div>`;const s=Vp(n,["channels",e.channelId]);if(!s)return c`<div class="callout danger">Channel config schema unavailable.</div>`;const i=e.configValue??{},o=Gp(i,e.channelId);return c`
    <div class="config-form">
      ${be({schema:s,value:o,path:["channels",e.channelId],hints:e.uiHints,unsupported:new Set(t.unsupportedPaths),disabled:e.disabled,showLabel:!1,onPatch:e.onPatch})}
    </div>
  `}function _e(e){const{channelId:t,props:n}=e,s=n.configSaving||n.configSchemaLoading;return c`
    <div style="margin-top: 16px;">
      ${n.configSchemaLoading?c`<div class="muted">Loading config schema…</div>`:Yp({channelId:t,configValue:n.configForm,schema:n.configSchema,uiHints:n.configUiHints,disabled:s,onPatch:n.onConfigPatch})}
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
  `}function Qp(e){const{props:t,discord:n,accountCountLabel:s}=e;return c`
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

      ${n?.lastError?c`<div class="callout danger" style="margin-top: 12px;">
            ${n.lastError}
          </div>`:g}

      ${n?.probe?c`<div class="callout" style="margin-top: 12px;">
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
  `}function Jp(e){const{props:t,imessage:n,accountCountLabel:s}=e;return c`
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

      ${n?.lastError?c`<div class="callout danger" style="margin-top: 12px;">
            ${n.lastError}
          </div>`:g}

      ${n?.probe?c`<div class="callout" style="margin-top: 12px;">
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
  `}function Zp(e){const{values:t,original:n}=e;return t.name!==n.name||t.displayName!==n.displayName||t.about!==n.about||t.picture!==n.picture||t.banner!==n.banner||t.website!==n.website||t.nip05!==n.nip05||t.lud16!==n.lud16}function Xp(e){const{state:t,callbacks:n,accountId:s}=e,i=Zp(t),o=(l,r,p={})=>{const{type:d="text",placeholder:u,maxLength:h,help:v}=p,w=t.values[l]??"",$=t.fieldErrors[l],x=`nostr-profile-${l}`;return d==="textarea"?c`
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
            @input=${C=>{const I=C.target;n.onFieldChange(l,I.value)}}
            ?disabled=${t.saving}
          ></textarea>
          ${v?c`<div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">${v}</div>`:g}
          ${$?c`<div style="font-size: 12px; color: var(--danger-color); margin-top: 2px;">${$}</div>`:g}
        </div>
      `:c`
      <div class="form-field" style="margin-bottom: 12px;">
        <label for="${x}" style="display: block; margin-bottom: 4px; font-weight: 500;">
          ${r}
        </label>
        <input
          id="${x}"
          type=${d}
          .value=${w}
          placeholder=${u??""}
          maxlength=${h??256}
          style="width: 100%; padding: 8px; border: 1px solid var(--border-color); border-radius: 4px;"
          @input=${C=>{const I=C.target;n.onFieldChange(l,I.value)}}
          ?disabled=${t.saving}
        />
        ${v?c`<div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">${v}</div>`:g}
        ${$?c`<div style="font-size: 12px; color: var(--danger-color); margin-top: 2px;">${$}</div>`:g}
      </div>
    `},a=()=>{const l=t.values.picture;return l?c`
      <div style="margin-bottom: 12px;">
        <img
          src=${l}
          alt="Profile picture preview"
          style="max-width: 80px; max-height: 80px; border-radius: 50%; object-fit: cover; border: 2px solid var(--border-color);"
          @error=${r=>{const p=r.target;p.style.display="none"}}
          @load=${r=>{const p=r.target;p.style.display="block"}}
        />
      </div>
    `:g};return c`
    <div class="nostr-profile-form" style="padding: 16px; background: var(--bg-secondary); border-radius: 8px; margin-top: 12px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <div style="font-weight: 600; font-size: 16px;">Edit Profile</div>
        <div style="font-size: 12px; color: var(--text-muted);">Account: ${s}</div>
      </div>

      ${t.error?c`<div class="callout danger" style="margin-bottom: 12px;">${t.error}</div>`:g}

      ${t.success?c`<div class="callout success" style="margin-bottom: 12px;">${t.success}</div>`:g}

      ${a()}

      ${o("name","Username",{placeholder:"satoshi",maxLength:256,help:"Short username (e.g., satoshi)"})}

      ${o("displayName","Display Name",{placeholder:"Satoshi Nakamoto",maxLength:256,help:"Your full display name"})}

      ${o("about","Bio",{type:"textarea",placeholder:"Tell people about yourself...",maxLength:2e3,help:"A brief bio or description"})}

      ${o("picture","Avatar URL",{type:"url",placeholder:"https://example.com/avatar.jpg",help:"HTTPS URL to your profile picture"})}

      ${t.showAdvanced?c`
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

      ${i?c`<div style="font-size: 12px; color: var(--warning-color); margin-top: 8px;">
            You have unsaved changes
          </div>`:g}
    </div>
  `}function ef(e){const t={name:e?.name??"",displayName:e?.displayName??"",about:e?.about??"",picture:e?.picture??"",banner:e?.banner??"",website:e?.website??"",nip05:e?.nip05??"",lud16:e?.lud16??""};return{values:t,original:{...t},saving:!1,importing:!1,error:null,success:null,fieldErrors:{},showAdvanced:!!(e?.banner||e?.website||e?.nip05||e?.lud16)}}function Ho(e){return e?e.length<=20?e:`${e.slice(0,8)}...${e.slice(-8)}`:"n/a"}function tf(e){const{props:t,nostr:n,nostrAccounts:s,accountCountLabel:i,profileFormState:o,profileFormCallbacks:a,onEditProfile:l}=e,r=s[0],p=n?.configured??r?.configured??!1,d=n?.running??r?.running??!1,u=n?.publicKey??r?.publicKey,h=n?.lastStartAt??r?.lastStartAt??null,v=n?.lastError??r?.lastError??null,w=s.length>1,$=o!=null,x=I=>{const R=I.publicKey,E=I.profile,A=E?.displayName??E?.name??I.name??I.accountId;return c`
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
            <span class="monospace" title="${R??""}">${Ho(R)}</span>
          </div>
          <div>
            <span class="label">Last inbound</span>
            <span>${I.lastInboundAt?O(I.lastInboundAt):"n/a"}</span>
          </div>
          ${I.lastError?c`
                <div class="account-card-error">${I.lastError}</div>
              `:g}
        </div>
      </div>
    `},C=()=>{if($&&a)return Xp({state:o,callbacks:a,accountId:s[0]?.accountId??"default"});const I=r?.profile??n?.profile,{name:R,displayName:E,about:A,picture:B,nip05:ue}=I??{},bn=R||E||A||B||ue;return c`
      <div style="margin-top: 16px; padding: 12px; background: var(--bg-secondary); border-radius: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <div style="font-weight: 500;">Profile</div>
          ${p?c`
                <button
                  class="btn btn-sm"
                  @click=${l}
                  style="font-size: 12px; padding: 4px 8px;"
                >
                  Edit Profile
                </button>
              `:g}
        </div>
        ${bn?c`
              <div class="status-list">
                ${B?c`
                      <div style="margin-bottom: 8px;">
                        <img
                          src=${B}
                          alt="Profile picture"
                          style="width: 48px; height: 48px; border-radius: 50%; object-fit: cover; border: 2px solid var(--border-color);"
                          @error=${yn=>{yn.target.style.display="none"}}
                        />
                      </div>
                    `:g}
                ${R?c`<div><span class="label">Name</span><span>${R}</span></div>`:g}
                ${E?c`<div><span class="label">Display Name</span><span>${E}</span></div>`:g}
                ${A?c`<div><span class="label">About</span><span style="max-width: 300px; overflow: hidden; text-overflow: ellipsis;">${A}</span></div>`:g}
                ${ue?c`<div><span class="label">NIP-05</span><span>${ue}</span></div>`:g}
              </div>
            `:c`
              <div style="color: var(--text-muted); font-size: 13px;">
                No profile set. Click "Edit Profile" to add your name, bio, and avatar.
              </div>
            `}
      </div>
    `};return c`
    <div class="card">
      <div class="card-title">Nostr</div>
      <div class="card-sub">Decentralized DMs via Nostr relays (NIP-04).</div>
      ${i}

      ${w?c`
            <div class="account-card-list">
              ${s.map(I=>x(I))}
            </div>
          `:c`
            <div class="status-list" style="margin-top: 16px;">
              <div>
                <span class="label">Configured</span>
                <span>${p?"Yes":"No"}</span>
              </div>
              <div>
                <span class="label">Running</span>
                <span>${d?"Yes":"No"}</span>
              </div>
              <div>
                <span class="label">Public Key</span>
                <span class="monospace" title="${u??""}"
                  >${Ho(u)}</span
                >
              </div>
              <div>
                <span class="label">Last start</span>
                <span>${h?O(h):"n/a"}</span>
              </div>
            </div>
          `}

      ${v?c`<div class="callout danger" style="margin-top: 12px;">${v}</div>`:g}

      ${C()}

      ${_e({channelId:"nostr",props:t})}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${()=>t.onRefresh(!1)}>Refresh</button>
      </div>
    </div>
  `}function nf(e){const{props:t,signal:n,accountCountLabel:s}=e;return c`
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

      ${n?.lastError?c`<div class="callout danger" style="margin-top: 12px;">
            ${n.lastError}
          </div>`:g}

      ${n?.probe?c`<div class="callout" style="margin-top: 12px;">
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
  `}function sf(e){const{props:t,slack:n,accountCountLabel:s}=e;return c`
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

      ${n?.lastError?c`<div class="callout danger" style="margin-top: 12px;">
            ${n.lastError}
          </div>`:g}

      ${n?.probe?c`<div class="callout" style="margin-top: 12px;">
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
  `}function of(e){const{props:t,telegram:n,telegramAccounts:s,accountCountLabel:i}=e,o=s.length>1,a=l=>{const p=l.probe?.bot?.username,d=l.name||l.accountId;return c`
      <div class="account-card">
        <div class="account-card-header">
          <div class="account-card-title">
            ${p?`@${p}`:d}
          </div>
          <div class="account-card-id">${l.accountId}</div>
        </div>
        <div class="status-list account-card-status">
          <div>
            <span class="label">Running</span>
            <span>${l.running?"Yes":"No"}</span>
          </div>
          <div>
            <span class="label">Configured</span>
            <span>${l.configured?"Yes":"No"}</span>
          </div>
          <div>
            <span class="label">Last inbound</span>
            <span>${l.lastInboundAt?O(l.lastInboundAt):"n/a"}</span>
          </div>
          ${l.lastError?c`
                <div class="account-card-error">
                  ${l.lastError}
                </div>
              `:g}
        </div>
      </div>
    `};return c`
    <div class="card">
      <div class="card-title">Telegram</div>
      <div class="card-sub">Bot status and channel configuration.</div>
      ${i}

      ${o?c`
            <div class="account-card-list">
              ${s.map(l=>a(l))}
            </div>
          `:c`
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

      ${n?.lastError?c`<div class="callout danger" style="margin-top: 12px;">
            ${n.lastError}
          </div>`:g}

      ${n?.probe?c`<div class="callout" style="margin-top: 12px;">
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
  `}function af(e){const{props:t,whatsapp:n,accountCountLabel:s}=e;return c`
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
            ${n?.authAgeMs!=null?jp(n.authAgeMs):"n/a"}
          </span>
        </div>
      </div>

      ${n?.lastError?c`<div class="callout danger" style="margin-top: 12px;">
            ${n.lastError}
          </div>`:g}

      ${t.whatsappMessage?c`<div class="callout" style="margin-top: 12px;">
            ${t.whatsappMessage}
          </div>`:g}

      ${t.whatsappQrDataUrl?c`<div class="qr-wrap">
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
  `}function rf(e){const t=e.snapshot?.channels,n=t?.whatsapp??void 0,s=t?.telegram??void 0,i=t?.discord??null,o=t?.slack??null,a=t?.signal??null,l=t?.imessage??null,r=t?.nostr??null,d=lf(e.snapshot).map((u,h)=>({key:u,enabled:qp(u,e),order:h})).sort((u,h)=>u.enabled!==h.enabled?u.enabled?-1:1:u.order-h.order);return c`
    <section class="grid grid-cols-2">
      ${d.map(u=>cf(u.key,e,{whatsapp:n,telegram:s,discord:i,slack:o,signal:a,imessage:l,nostr:r,channelAccounts:e.snapshot?.channelAccounts??null}))}
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Channel health</div>
          <div class="card-sub">Channel status snapshots from the gateway.</div>
        </div>
        <div class="muted">${e.lastSuccessAt?O(e.lastSuccessAt):"n/a"}</div>
      </div>
      ${e.lastError?c`<div class="callout danger" style="margin-top: 12px;">
            ${e.lastError}
          </div>`:g}
      <pre class="code-block" style="margin-top: 12px;">
${e.snapshot?JSON.stringify(e.snapshot,null,2):"No snapshot yet."}
      </pre>
    </section>
  `}function lf(e){return e?.channelMeta?.length?e.channelMeta.map(t=>t.id):e?.channelOrder?.length?e.channelOrder:["whatsapp","telegram","discord","slack","signal","imessage","nostr"]}function cf(e,t,n){const s=gr(e,n.channelAccounts);switch(e){case"whatsapp":return af({props:t,whatsapp:n.whatsapp,accountCountLabel:s});case"telegram":return of({props:t,telegram:n.telegram,telegramAccounts:n.channelAccounts?.telegram??[],accountCountLabel:s});case"discord":return Qp({props:t,discord:n.discord,accountCountLabel:s});case"slack":return sf({props:t,slack:n.slack,accountCountLabel:s});case"signal":return nf({props:t,signal:n.signal,accountCountLabel:s});case"imessage":return Jp({props:t,imessage:n.imessage,accountCountLabel:s});case"nostr":{const i=n.channelAccounts?.nostr??[],o=i[0],a=o?.accountId??"default",l=o?.profile??null,r=t.nostrProfileAccountId===a?t.nostrProfileFormState:null,p=r?{onFieldChange:t.onNostrProfileFieldChange,onSave:t.onNostrProfileSave,onImport:t.onNostrProfileImport,onCancel:t.onNostrProfileCancel,onToggleAdvanced:t.onNostrProfileToggleAdvanced}:null;return tf({props:t,nostr:n.nostr,nostrAccounts:i,accountCountLabel:s,profileFormState:r,profileFormCallbacks:p,onEditProfile:()=>t.onNostrProfileEdit(a,l)})}default:return df(e,t,n.channelAccounts??{})}}function df(e,t,n){const s=pf(t.snapshot,e),i=t.snapshot?.channels?.[e],o=typeof i?.configured=="boolean"?i.configured:void 0,a=typeof i?.running=="boolean"?i.running:void 0,l=typeof i?.connected=="boolean"?i.connected:void 0,r=typeof i?.lastError=="string"?i.lastError:void 0,p=n[e]??[],d=gr(e,n);return c`
    <div class="card">
      <div class="card-title">${s}</div>
      <div class="card-sub">Channel status and configuration.</div>
      ${d}

      ${p.length>0?c`
            <div class="account-card-list">
              ${p.map(u=>vf(u))}
            </div>
          `:c`
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
                <span>${l==null?"n/a":l?"Yes":"No"}</span>
              </div>
            </div>
          `}

      ${r?c`<div class="callout danger" style="margin-top: 12px;">
            ${r}
          </div>`:g}

      ${_e({channelId:e,props:t})}
    </div>
  `}function uf(e){return e?.channelMeta?.length?Object.fromEntries(e.channelMeta.map(t=>[t.id,t])):{}}function pf(e,t){return uf(e)[t]?.label??e?.channelLabels?.[t]??t}const ff=600*1e3;function vr(e){return e.lastInboundAt?Date.now()-e.lastInboundAt<ff:!1}function hf(e){return e.running?"Yes":vr(e)?"Active":"No"}function gf(e){return e.connected===!0?"Yes":e.connected===!1?"No":vr(e)?"Active":"n/a"}function vf(e){const t=hf(e),n=gf(e);return c`
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
        ${e.lastError?c`
              <div class="account-card-error">
                ${e.lastError}
              </div>
            `:g}
      </div>
    </div>
  `}function mf(e){const t=e.host??"unknown",n=e.ip?`(${e.ip})`:"",s=e.mode??"",i=e.version??"";return`${t} ${n} ${s} ${i}`.trim()}function bf(e){const t=e.ts??null;return t?O(t):"n/a"}function mr(e){return e?`${xt(e)} (${O(e)})`:"n/a"}function yf(e){if(e.totalTokens==null)return"n/a";const t=e.totalTokens??0,n=e.contextTokens??0;return n?`${t} / ${n}`:String(t)}function wf(e){if(e==null)return"";try{return JSON.stringify(e,null,2)}catch{return String(e)}}function $f(e){const t=e.state??{},n=t.nextRunAtMs?xt(t.nextRunAtMs):"n/a",s=t.lastRunAtMs?xt(t.lastRunAtMs):"n/a";return`${t.lastStatus??"n/a"} · next ${n} · last ${s}`}function kf(e){const t=e.schedule;return t.kind==="at"?`At ${xt(t.atMs)}`:t.kind==="every"?`Every ${ra(t.everyMs)}`:`Cron ${t.expr}${t.tz?` (${t.tz})`:""}`}function xf(e){const t=e.payload;return t.kind==="systemEvent"?`System: ${t.text}`:`Agent: ${t.message}`}function Af(e){const t=["last",...e.channels.filter(Boolean)],n=e.form.channel?.trim();n&&!t.includes(n)&&t.push(n);const s=new Set;return t.filter(i=>s.has(i)?!1:(s.add(i),!0))}function Sf(e,t){if(t==="last")return"last";const n=e.channelMeta?.find(s=>s.id===t);return n?.label?n.label:e.channelLabels?.[t]??t}function _f(e){const t=Af(e);return c`
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
            <div class="stat-value">${mr(e.status?.nextWakeAtMs??null)}</div>
          </div>
        </div>
        <div class="row" style="margin-top: 12px;">
          <button class="btn" ?disabled=${e.loading} @click=${e.onRefresh}>
            ${e.loading?"Refreshing…":"Refresh"}
          </button>
          ${e.error?c`<span class="muted">${e.error}</span>`:g}
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
        ${Tf(e)}
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
	          ${e.form.payloadKind==="agentTurn"?c`
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
	                    ${t.map(n=>c`<option value=${n}>
                            ${Sf(e,n)}
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
                ${e.form.sessionTarget==="isolated"?c`
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
      ${e.jobs.length===0?c`<div class="muted" style="margin-top: 12px;">No jobs yet.</div>`:c`
            <div class="list" style="margin-top: 12px;">
              ${e.jobs.map(n=>Cf(n,e))}
            </div>
          `}
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">Run history</div>
      <div class="card-sub">Latest runs for ${e.runsJobId??"(select a job)"}.</div>
      ${e.runsJobId==null?c`
            <div class="muted" style="margin-top: 12px;">
              Select a job to inspect run history.
            </div>
          `:e.runs.length===0?c`<div class="muted" style="margin-top: 12px;">No runs yet.</div>`:c`
              <div class="list" style="margin-top: 12px;">
                ${e.runs.map(n=>Ef(n))}
              </div>
            `}
    </section>
  `}function Tf(e){const t=e.form;return t.scheduleKind==="at"?c`
      <label class="field" style="margin-top: 12px;">
        <span>Run at</span>
        <input
          type="datetime-local"
          .value=${t.scheduleAt}
          @input=${n=>e.onFormChange({scheduleAt:n.target.value})}
        />
      </label>
    `:t.scheduleKind==="every"?c`
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
    `:c`
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
  `}function Cf(e,t){const s=`list-item list-item-clickable${t.runsJobId===e.id?" list-item-selected":""}`;return c`
    <div class=${s} @click=${()=>t.onLoadRuns(e.id)}>
      <div class="list-main">
        <div class="list-title">${e.name}</div>
        <div class="list-sub">${kf(e)}</div>
        <div class="muted">${xf(e)}</div>
        ${e.agentId?c`<div class="muted">Agent: ${e.agentId}</div>`:g}
        <div class="chip-row" style="margin-top: 6px;">
          <span class="chip">${e.enabled?"enabled":"disabled"}</span>
          <span class="chip">${e.sessionTarget}</span>
          <span class="chip">${e.wakeMode}</span>
        </div>
      </div>
      <div class="list-meta">
        <div>${$f(e)}</div>
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
  `}function Ef(e){return c`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${e.status}</div>
        <div class="list-sub">${e.summary??""}</div>
      </div>
      <div class="list-meta">
        <div>${xt(e.ts)}</div>
        <div class="muted">${e.durationMs??0}ms</div>
        ${e.error?c`<div class="muted">${e.error}</div>`:g}
      </div>
    </div>
  `}function If(e){return c`
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
        ${e.callError?c`<div class="callout danger" style="margin-top: 12px;">
              ${e.callError}
            </div>`:g}
        ${e.callResult?c`<pre class="code-block" style="margin-top: 12px;">${e.callResult}</pre>`:g}
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
      ${e.eventLog.length===0?c`<div class="muted" style="margin-top: 12px;">No events yet.</div>`:c`
            <div class="list" style="margin-top: 12px;">
              ${e.eventLog.map(t=>c`
                  <div class="list-item">
                    <div class="list-main">
                      <div class="list-title">${t.event}</div>
                      <div class="list-sub">${new Date(t.ts).toLocaleTimeString()}</div>
                    </div>
                    <div class="list-meta">
                      <pre class="code-block">${wf(t.payload)}</pre>
                    </div>
                  </div>
                `)}
            </div>
          `}
    </section>
  `}function Lf(e){return c`
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
      ${e.lastError?c`<div class="callout danger" style="margin-top: 12px;">
            ${e.lastError}
          </div>`:g}
      ${e.statusMessage?c`<div class="callout" style="margin-top: 12px;">
            ${e.statusMessage}
          </div>`:g}
      <div class="list" style="margin-top: 16px;">
        ${e.entries.length===0?c`<div class="muted">No instances reported yet.</div>`:e.entries.map(t=>Rf(t))}
      </div>
    </section>
  `}function Rf(e){const t=e.lastInputSeconds!=null?`${e.lastInputSeconds}s ago`:"n/a",n=e.mode??"unknown",s=Array.isArray(e.roles)?e.roles.filter(Boolean):[],i=Array.isArray(e.scopes)?e.scopes.filter(Boolean):[],o=i.length>0?i.length>3?`${i.length} scopes`:`scopes: ${i.join(", ")}`:null;return c`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${e.host??"unknown host"}</div>
        <div class="list-sub">${mf(e)}</div>
        <div class="chip-row">
          <span class="chip">${n}</span>
          ${s.map(a=>c`<span class="chip">${a}</span>`)}
          ${o?c`<span class="chip">${o}</span>`:g}
          ${e.platform?c`<span class="chip">${e.platform}</span>`:g}
          ${e.deviceFamily?c`<span class="chip">${e.deviceFamily}</span>`:g}
          ${e.modelIdentifier?c`<span class="chip">${e.modelIdentifier}</span>`:g}
          ${e.version?c`<span class="chip">${e.version}</span>`:g}
        </div>
      </div>
      <div class="list-meta">
        <div>${bf(e)}</div>
        <div class="muted">Last input ${t}</div>
        <div class="muted">Reason ${e.reason??""}</div>
      </div>
    </div>
  `}const zo=["trace","debug","info","warn","error","fatal"];function Mf(e){if(!e)return"";const t=new Date(e);return Number.isNaN(t.getTime())?e:t.toLocaleTimeString()}function Pf(e,t){return t?[e.message,e.subsystem,e.raw].filter(Boolean).join(" ").toLowerCase().includes(t):!0}function Nf(e){const t=e.filterText.trim().toLowerCase(),n=zo.some(o=>!e.levelFilters[o]),s=e.entries.filter(o=>o.level&&!e.levelFilters[o.level]?!1:Pf(o,t)),i=t||n?"filtered":"visible";return c`
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
        ${zo.map(o=>c`
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

      ${e.file?c`<div class="muted" style="margin-top: 10px;">File: ${e.file}</div>`:g}
      ${e.truncated?c`<div class="callout" style="margin-top: 10px;">
            Log output truncated; showing latest chunk.
          </div>`:g}
      ${e.error?c`<div class="callout danger" style="margin-top: 10px;">${e.error}</div>`:g}

      <div class="log-stream" style="margin-top: 12px;" @scroll=${e.onScroll}>
        ${s.length===0?c`<div class="muted" style="padding: 12px;">No log entries.</div>`:s.map(o=>c`
                <div class="log-row">
                  <div class="log-time mono">${Mf(o.time)}</div>
                  <div class="log-level ${o.level??""}">${o.level??""}</div>
                  <div class="log-subsystem mono">${o.subsystem??""}</div>
                  <div class="log-message mono">${o.message??o.raw}</div>
                </div>
              `)}
      </div>
    </section>
  `}function Of(e){const t=Hf(e),n=Gf(e);return c`
    ${Qf(n)}
    ${Yf(t)}
    ${Df(e)}
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
        ${e.nodes.length===0?c`<div class="muted">No nodes found.</div>`:e.nodes.map(s=>ah(s))}
      </div>
    </section>
  `}function Df(e){const t=e.devicesList??{pending:[],paired:[]},n=Array.isArray(t.pending)?t.pending:[],s=Array.isArray(t.paired)?t.paired:[];return c`
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
      ${e.devicesError?c`<div class="callout danger" style="margin-top: 12px;">${e.devicesError}</div>`:g}
      <div class="list" style="margin-top: 16px;">
        ${n.length>0?c`
              <div class="muted" style="margin-bottom: 8px;">Pending</div>
              ${n.map(i=>Bf(i,e))}
            `:g}
        ${s.length>0?c`
              <div class="muted" style="margin-top: 12px; margin-bottom: 8px;">Paired</div>
              ${s.map(i=>Ff(i,e))}
            `:g}
        ${n.length===0&&s.length===0?c`<div class="muted">No paired devices.</div>`:g}
      </div>
    </section>
  `}function Bf(e,t){const n=e.displayName?.trim()||e.deviceId,s=typeof e.ts=="number"?O(e.ts):"n/a",i=e.role?.trim()?`role: ${e.role}`:"role: -",o=e.isRepair?" · repair":"",a=e.remoteIp?` · ${e.remoteIp}`:"";return c`
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
  `}function Ff(e,t){const n=e.displayName?.trim()||e.deviceId,s=e.remoteIp?` · ${e.remoteIp}`:"",i=`roles: ${os(e.roles)}`,o=`scopes: ${os(e.scopes)}`,a=Array.isArray(e.tokens)?e.tokens:[];return c`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${n}</div>
        <div class="list-sub">${e.deviceId}${s}</div>
        <div class="muted" style="margin-top: 6px;">${i} · ${o}</div>
        ${a.length===0?c`<div class="muted" style="margin-top: 6px;">Tokens: none</div>`:c`
              <div class="muted" style="margin-top: 10px;">Tokens</div>
              <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 6px;">
                ${a.map(l=>Uf(e.deviceId,l,t))}
              </div>
            `}
      </div>
    </div>
  `}function Uf(e,t,n){const s=t.revokedAtMs?"revoked":"active",i=`scopes: ${os(t.scopes)}`,o=O(t.rotatedAtMs??t.createdAtMs??t.lastUsedAtMs??null);return c`
    <div class="row" style="justify-content: space-between; gap: 8px;">
      <div class="list-sub">${t.role} · ${s} · ${i} · ${o}</div>
      <div class="row" style="justify-content: flex-end; gap: 6px; flex-wrap: wrap;">
        <button
          class="btn btn--sm"
          @click=${()=>n.onDeviceRotate(e,t.role,t.scopes)}
        >
          Rotate
        </button>
        ${t.revokedAtMs?g:c`
              <button
                class="btn btn--sm danger"
                @click=${()=>n.onDeviceRevoke(e,t.role)}
              >
                Revoke
              </button>
            `}
      </div>
    </div>
  `}const ke="__defaults__",jo=[{value:"deny",label:"Deny"},{value:"allowlist",label:"Allowlist"},{value:"full",label:"Full"}],Kf=[{value:"off",label:"Off"},{value:"on-miss",label:"On miss"},{value:"always",label:"Always"}];function Hf(e){const t=e.configForm,n=sh(e.nodes),{defaultBinding:s,agents:i}=oh(t),o=!!t,a=e.configSaving||e.configFormMode==="raw";return{ready:o,disabled:a,configDirty:e.configDirty,configLoading:e.configLoading,configSaving:e.configSaving,defaultBinding:s,agents:i,nodes:n,onBindDefault:e.onBindDefault,onBindAgent:e.onBindAgent,onSave:e.onSaveBindings,onLoadConfig:e.onLoadConfig,formMode:e.configFormMode}}function qo(e){return e==="allowlist"||e==="full"||e==="deny"?e:"deny"}function zf(e){return e==="always"||e==="off"||e==="on-miss"?e:"on-miss"}function jf(e){const t=e?.defaults??{};return{security:qo(t.security),ask:zf(t.ask),askFallback:qo(t.askFallback??"deny"),autoAllowSkills:!!(t.autoAllowSkills??!1)}}function qf(e){const t=e?.agents??{},n=Array.isArray(t.list)?t.list:[],s=[];return n.forEach(i=>{if(!i||typeof i!="object")return;const o=i,a=typeof o.id=="string"?o.id.trim():"";if(!a)return;const l=typeof o.name=="string"?o.name.trim():void 0,r=o.default===!0;s.push({id:a,name:l||void 0,isDefault:r})}),s}function Wf(e,t){const n=qf(e),s=Object.keys(t?.agents??{}),i=new Map;n.forEach(a=>i.set(a.id,a)),s.forEach(a=>{i.has(a)||i.set(a,{id:a})});const o=Array.from(i.values());return o.length===0&&o.push({id:"main",isDefault:!0}),o.sort((a,l)=>{if(a.isDefault&&!l.isDefault)return-1;if(!a.isDefault&&l.isDefault)return 1;const r=a.name?.trim()?a.name:a.id,p=l.name?.trim()?l.name:l.id;return r.localeCompare(p)}),o}function Vf(e,t){return e===ke?ke:e&&t.some(n=>n.id===e)?e:ke}function Gf(e){const t=e.execApprovalsForm??e.execApprovalsSnapshot?.file??null,n=!!t,s=jf(t),i=Wf(e.configForm,t),o=ih(e.nodes),a=e.execApprovalsTarget;let l=a==="node"&&e.execApprovalsTargetNodeId?e.execApprovalsTargetNodeId:null;a==="node"&&l&&!o.some(u=>u.id===l)&&(l=null);const r=Vf(e.execApprovalsSelectedAgent,i),p=r!==ke?(t?.agents??{})[r]??null:null,d=Array.isArray(p?.allowlist)?p.allowlist??[]:[];return{ready:n,disabled:e.execApprovalsSaving||e.execApprovalsLoading,dirty:e.execApprovalsDirty,loading:e.execApprovalsLoading,saving:e.execApprovalsSaving,form:t,defaults:s,selectedScope:r,selectedAgent:p,agents:i,allowlist:d,target:a,targetNodeId:l,targetNodes:o,onSelectScope:e.onExecApprovalsSelectAgent,onSelectTarget:e.onExecApprovalsTargetChange,onPatch:e.onExecApprovalsPatch,onRemove:e.onExecApprovalsRemove,onLoad:e.onLoadExecApprovals,onSave:e.onSaveExecApprovals}}function Yf(e){const t=e.nodes.length>0,n=e.defaultBinding??"";return c`
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

      ${e.formMode==="raw"?c`<div class="callout warn" style="margin-top: 12px;">
            Switch the Config tab to <strong>Form</strong> mode to edit bindings here.
          </div>`:g}

      ${e.ready?c`
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
                      ${e.nodes.map(s=>c`<option
                            value=${s.id}
                            ?selected=${n===s.id}
                          >
                            ${s.label}
                          </option>`)}
                    </select>
                  </label>
                  ${t?g:c`<div class="muted">No nodes with system.run available.</div>`}
                </div>
              </div>

              ${e.agents.length===0?c`<div class="muted">No agents found.</div>`:e.agents.map(s=>nh(s,e))}
            </div>
          `:c`<div class="row" style="margin-top: 12px; gap: 12px;">
            <div class="muted">Load config to edit bindings.</div>
            <button class="btn" ?disabled=${e.configLoading} @click=${e.onLoadConfig}>
              ${e.configLoading?"Loading…":"Load config"}
            </button>
          </div>`}
    </section>
  `}function Qf(e){const t=e.ready,n=e.target!=="node"||!!e.targetNodeId;return c`
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

      ${Jf(e)}

      ${t?c`
            ${Zf(e)}
            ${Xf(e)}
            ${e.selectedScope===ke?g:eh(e)}
          `:c`<div class="row" style="margin-top: 12px; gap: 12px;">
            <div class="muted">Load exec approvals to edit allowlists.</div>
            <button class="btn" ?disabled=${e.loading||!n} @click=${e.onLoad}>
              ${e.loading?"Loading…":"Load approvals"}
            </button>
          </div>`}
    </section>
  `}function Jf(e){const t=e.targetNodes.length>0,n=e.targetNodeId??"";return c`
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
          ${e.target==="node"?c`
                <label class="field">
                  <span>Node</span>
                  <select
                    ?disabled=${e.disabled||!t}
                    @change=${s=>{const o=s.target.value.trim();e.onSelectTarget("node",o||null)}}
                  >
                    <option value="" ?selected=${n===""}>Select node</option>
                    ${e.targetNodes.map(s=>c`<option
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
      ${e.target==="node"&&!t?c`<div class="muted">No nodes advertise exec approvals yet.</div>`:g}
    </div>
  `}function Zf(e){return c`
    <div class="row" style="margin-top: 12px; gap: 8px; flex-wrap: wrap;">
      <span class="label">Scope</span>
      <div class="row" style="gap: 8px; flex-wrap: wrap;">
        <button
          class="btn btn--sm ${e.selectedScope===ke?"active":""}"
          @click=${()=>e.onSelectScope(ke)}
        >
          Defaults
        </button>
        ${e.agents.map(t=>{const n=t.name?.trim()?`${t.name} (${t.id})`:t.id;return c`
            <button
              class="btn btn--sm ${e.selectedScope===t.id?"active":""}"
              @click=${()=>e.onSelectScope(t.id)}
            >
              ${n}
            </button>
          `})}
      </div>
    </div>
  `}function Xf(e){const t=e.selectedScope===ke,n=e.defaults,s=e.selectedAgent??{},i=t?["defaults"]:["agents",e.selectedScope],o=typeof s.security=="string"?s.security:void 0,a=typeof s.ask=="string"?s.ask:void 0,l=typeof s.askFallback=="string"?s.askFallback:void 0,r=t?n.security:o??"__default__",p=t?n.ask:a??"__default__",d=t?n.askFallback:l??"__default__",u=typeof s.autoAllowSkills=="boolean"?s.autoAllowSkills:void 0,h=u??n.autoAllowSkills,v=u==null;return c`
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
              ${t?g:c`<option value="__default__" ?selected=${r==="__default__"}>
                    Use default (${n.security})
                  </option>`}
              ${jo.map(w=>c`<option
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
              ${t?g:c`<option value="__default__" ?selected=${p==="__default__"}>
                    Use default (${n.ask})
                  </option>`}
              ${Kf.map(w=>c`<option
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
              ${t?g:c`<option value="__default__" ?selected=${d==="__default__"}>
                    Use default (${n.askFallback})
                  </option>`}
              ${jo.map(w=>c`<option
                    value=${w.value}
                    ?selected=${d===w.value}
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
          ${!t&&!v?c`<button
                class="btn btn--sm"
                ?disabled=${e.disabled}
                @click=${()=>e.onRemove([...i,"autoAllowSkills"])}
              >
                Use default
              </button>`:g}
        </div>
      </div>
    </div>
  `}function eh(e){const t=["agents",e.selectedScope,"allowlist"],n=e.allowlist;return c`
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
      ${n.length===0?c`<div class="muted">No allowlist entries yet.</div>`:n.map((s,i)=>th(e,s,i))}
    </div>
  `}function th(e,t,n){const s=t.lastUsedAt?O(t.lastUsedAt):"never",i=t.lastUsedCommand?as(t.lastUsedCommand,120):null,o=t.lastResolvedPath?as(t.lastResolvedPath,120):null;return c`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${t.pattern?.trim()?t.pattern:"New pattern"}</div>
        <div class="list-sub">Last used: ${s}</div>
        ${i?c`<div class="list-sub mono">${i}</div>`:g}
        ${o?c`<div class="list-sub mono">${o}</div>`:g}
      </div>
      <div class="list-meta">
        <label class="field">
          <span>Pattern</span>
          <input
            type="text"
            .value=${t.pattern??""}
            ?disabled=${e.disabled}
            @input=${a=>{const l=a.target;e.onPatch(["agents",e.selectedScope,"allowlist",n,"pattern"],l.value)}}
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
  `}function nh(e,t){const n=e.binding??"__default__",s=e.name?.trim()?`${e.name} (${e.id})`:e.id,i=t.nodes.length>0;return c`
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
            @change=${o=>{const l=o.target.value.trim();t.onBindAgent(e.index,l==="__default__"?null:l)}}
          >
            <option value="__default__" ?selected=${n==="__default__"}>
              Use default
            </option>
            ${t.nodes.map(o=>c`<option
                  value=${o.id}
                  ?selected=${n===o.id}
                >
                  ${o.label}
                </option>`)}
          </select>
        </label>
      </div>
    </div>
  `}function sh(e){const t=[];for(const n of e){if(!(Array.isArray(n.commands)?n.commands:[]).some(l=>String(l)==="system.run"))continue;const o=typeof n.nodeId=="string"?n.nodeId.trim():"";if(!o)continue;const a=typeof n.displayName=="string"&&n.displayName.trim()?n.displayName.trim():o;t.push({id:o,label:a===o?o:`${a} · ${o}`})}return t.sort((n,s)=>n.label.localeCompare(s.label)),t}function ih(e){const t=[];for(const n of e){if(!(Array.isArray(n.commands)?n.commands:[]).some(l=>String(l)==="system.execApprovals.get"||String(l)==="system.execApprovals.set"))continue;const o=typeof n.nodeId=="string"?n.nodeId.trim():"";if(!o)continue;const a=typeof n.displayName=="string"&&n.displayName.trim()?n.displayName.trim():o;t.push({id:o,label:a===o?o:`${a} · ${o}`})}return t.sort((n,s)=>n.label.localeCompare(s.label)),t}function oh(e){const t={id:"main",name:void 0,index:0,isDefault:!0,binding:null};if(!e||typeof e!="object")return{defaultBinding:null,agents:[t]};const s=(e.tools??{}).exec??{},i=typeof s.node=="string"&&s.node.trim()?s.node.trim():null,o=e.agents??{},a=Array.isArray(o.list)?o.list:[];if(a.length===0)return{defaultBinding:i,agents:[t]};const l=[];return a.forEach((r,p)=>{if(!r||typeof r!="object")return;const d=r,u=typeof d.id=="string"?d.id.trim():"";if(!u)return;const h=typeof d.name=="string"?d.name.trim():void 0,v=d.default===!0,$=(d.tools??{}).exec??{},x=typeof $.node=="string"&&$.node.trim()?$.node.trim():null;l.push({id:u,name:h||void 0,index:p,isDefault:v,binding:x})}),l.length===0&&l.push(t),{defaultBinding:i,agents:l}}function ah(e){const t=!!e.connected,n=!!e.paired,s=typeof e.displayName=="string"&&e.displayName.trim()||(typeof e.nodeId=="string"?e.nodeId:"unknown"),i=Array.isArray(e.caps)?e.caps:[],o=Array.isArray(e.commands)?e.commands:[];return c`
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
          ${i.slice(0,12).map(a=>c`<span class="chip">${String(a)}</span>`)}
          ${o.slice(0,8).map(a=>c`<span class="chip">${String(a)}</span>`)}
        </div>
      </div>
    </div>
  `}function rh(e){const t=e.hello?.snapshot,n=t?.uptimeMs?ra(t.uptimeMs):"n/a",s=t?.policy?.tickIntervalMs?`${t.policy.tickIntervalMs}ms`:"n/a",i=(()=>{if(e.connected||!e.lastError)return null;const a=e.lastError.toLowerCase();if(!(a.includes("unauthorized")||a.includes("connect failed")))return null;const r=!!e.settings.token.trim(),p=!!e.password.trim();return!r&&!p?c`
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
      `:c`
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
    `})(),o=(()=>{if(e.connected||!e.lastError||(typeof window<"u"?window.isSecureContext:!0)!==!1)return null;const l=e.lastError.toLowerCase();return!l.includes("secure context")&&!l.includes("device identity required")?null:c`
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
    `})();return c`
    <section class="grid grid-cols-2">
      <div class="card">
        <div class="card-title">Gateway Access</div>
        <div class="card-sub">Where the dashboard connects and how it authenticates.</div>
        <div class="form-grid" style="margin-top: 16px;">
          <label class="field">
            <span>WebSocket URL</span>
            <input
              .value=${e.settings.gatewayUrl}
              @input=${a=>{const l=a.target.value;e.onSettingsChange({...e.settings,gatewayUrl:l})}}
              placeholder="ws://100.x.y.z:18789"
            />
          </label>
          <label class="field">
            <span>Gateway Token</span>
            <input
              .value=${e.settings.token}
              @input=${a=>{const l=a.target.value;e.onSettingsChange({...e.settings,token:l})}}
              placeholder="CLAWDBOT_GATEWAY_TOKEN"
            />
          </label>
          <label class="field">
            <span>Password (not stored)</span>
            <input
              type="password"
              .value=${e.password}
              @input=${a=>{const l=a.target.value;e.onPasswordChange(l)}}
              placeholder="system or shared password"
            />
          </label>
          <label class="field">
            <span>Default Session Key</span>
            <input
              .value=${e.settings.sessionKey}
              @input=${a=>{const l=a.target.value;e.onSessionKeyChange(l)}}
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
        ${e.lastError?c`<div class="callout danger" style="margin-top: 14px;">
              <div>${e.lastError}</div>
              ${i??""}
              ${o??""}
            </div>`:c`<div class="callout" style="margin-top: 14px;">
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
        <div class="muted">Next wake ${mr(e.cronNext)}</div>
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
  `}const lh=["","off","minimal","low","medium","high"],ch=["","off","on"],dh=[{value:"",label:"inherit"},{value:"off",label:"off (explicit)"},{value:"on",label:"on"}],uh=["","off","on","stream"];function ph(e){if(!e)return"";const t=e.trim().toLowerCase();return t==="z.ai"||t==="z-ai"?"zai":t}function br(e){return ph(e)==="zai"}function fh(e){return br(e)?ch:lh}function hh(e,t){return!t||!e||e==="off"?e:"on"}function gh(e,t){return e?t&&e==="on"?"low":e:null}function vh(e){const t=e.result?.sessions??[];return c`
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

      ${e.error?c`<div class="callout danger" style="margin-top: 12px;">${e.error}</div>`:g}

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
        ${t.length===0?c`<div class="muted">No sessions found.</div>`:t.map(n=>mh(n,e.basePath,e.onPatch,e.onDelete,e.loading))}
      </div>
    </section>
  `}function mh(e,t,n,s,i){const o=e.updatedAt?O(e.updatedAt):"n/a",a=e.thinkingLevel??"",l=br(e.modelProvider),r=hh(a,l),p=fh(e.modelProvider),d=e.verboseLevel??"",u=e.reasoningLevel??"",h=e.displayName??e.key,v=e.kind!=="global",w=v?`${Ps("chat",t)}?session=${encodeURIComponent(e.key)}`:null;return c`
    <div class="table-row">
      <div class="mono">${v?c`<a href=${w} class="session-link">${h}</a>`:h}</div>
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
      <div>${yf(e)}</div>
      <div>
        <select
          .value=${r}
          ?disabled=${i}
          @change=${$=>{const x=$.target.value;n(e.key,{thinkingLevel:gh(x,l)})}}
        >
          ${p.map($=>c`<option value=${$}>${$||"inherit"}</option>`)}
        </select>
      </div>
      <div>
        <select
          .value=${d}
          ?disabled=${i}
          @change=${$=>{const x=$.target.value;n(e.key,{verboseLevel:x||null})}}
        >
          ${dh.map($=>c`<option value=${$.value}>${$.label}</option>`)}
        </select>
      </div>
      <div>
        <select
          .value=${u}
          ?disabled=${i}
          @change=${$=>{const x=$.target.value;n(e.key,{reasoningLevel:x||null})}}
        >
          ${uh.map($=>c`<option value=${$}>${$||"inherit"}</option>`)}
        </select>
      </div>
      <div>
        <button class="btn danger" ?disabled=${i} @click=${()=>s(e.key)}>
          Delete
        </button>
      </div>
    </div>
  `}function bh(e){const t=Math.max(0,e),n=Math.floor(t/1e3);if(n<60)return`${n}s`;const s=Math.floor(n/60);return s<60?`${s}m`:`${Math.floor(s/60)}h`}function Le(e,t){return t?c`<div class="exec-approval-meta-row"><span>${e}</span><span>${t}</span></div>`:g}function yh(e){const t=e.execApprovalQueue[0];if(!t)return g;const n=t.request,s=t.expiresAtMs-Date.now(),i=s>0?`expires in ${bh(s)}`:"expired",o=e.execApprovalQueue.length;return c`
    <div class="exec-approval-overlay" role="dialog" aria-live="polite">
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">Exec approval needed</div>
            <div class="exec-approval-sub">${i}</div>
          </div>
          ${o>1?c`<div class="exec-approval-queue">${o} pending</div>`:g}
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
        ${e.execApprovalError?c`<div class="exec-approval-error">${e.execApprovalError}</div>`:g}
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
  `}function wh(e){const t=e.report?.skills??[],n=e.filter.trim().toLowerCase(),s=n?t.filter(i=>[i.name,i.description,i.source].join(" ").toLowerCase().includes(n)):t;return c`
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

      ${e.error?c`<div class="callout danger" style="margin-top: 12px;">${e.error}</div>`:g}

      ${s.length===0?c`<div class="muted" style="margin-top: 16px;">No skills found.</div>`:c`
            <div class="list" style="margin-top: 16px;">
              ${s.map(i=>$h(i,e))}
            </div>
          `}
    </section>
  `}function $h(e,t){const n=t.busyKey===e.skillKey,s=t.edits[e.skillKey]??"",i=t.messages[e.skillKey]??null,o=e.install.length>0&&e.missing.bins.length>0,a=[...e.missing.bins.map(r=>`bin:${r}`),...e.missing.env.map(r=>`env:${r}`),...e.missing.config.map(r=>`config:${r}`),...e.missing.os.map(r=>`os:${r}`)],l=[];return e.disabled&&l.push("disabled"),e.blockedByAllowlist&&l.push("blocked by allowlist"),c`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">
          ${e.emoji?`${e.emoji} `:""}${e.name}
        </div>
        <div class="list-sub">${as(e.description,140)}</div>
        <div class="chip-row" style="margin-top: 6px;">
          <span class="chip">${e.source}</span>
          <span class="chip ${e.eligible?"chip-ok":"chip-warn"}">
            ${e.eligible?"eligible":"blocked"}
          </span>
          ${e.disabled?c`<span class="chip chip-warn">disabled</span>`:g}
        </div>
        ${a.length>0?c`
              <div class="muted" style="margin-top: 6px;">
                Missing: ${a.join(", ")}
              </div>
            `:g}
        ${l.length>0?c`
              <div class="muted" style="margin-top: 6px;">
                Reason: ${l.join(", ")}
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
          ${o?c`<button
                class="btn"
                ?disabled=${n}
                @click=${()=>t.onInstall(e.skillKey,e.name,e.install[0].id)}
              >
                ${n?"Installing…":e.install[0].label}
              </button>`:g}
        </div>
        ${i?c`<div
              class="muted"
              style="margin-top: 8px; color: ${i.kind==="error"?"var(--danger-color, #d14343)":"var(--success-color, #0a7f5a)"};"
            >
              ${i.message}
            </div>`:g}
        ${e.primaryEnv?c`
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
  `}function kh(e,t){const n=Ps(t,e.basePath);return c`
    <a
      href=${n}
      class="nav-item ${e.tab===t?"active":""}"
      @click=${s=>{s.defaultPrevented||s.button!==0||s.metaKey||s.ctrlKey||s.shiftKey||s.altKey||(s.preventDefault(),e.setTab(t))}}
      title=${is(t)}
    >
      <span class="nav-item__icon" aria-hidden="true">${bl(t)}</span>
      <span class="nav-item__text">${is(t)}</span>
    </a>
  `}function xh(e){const t=Ah(e.sessionKey,e.sessionsResult),n=e.onboarding,s=e.onboarding,i=e.onboarding?!1:e.settings.chatShowThinking,o=e.onboarding?!0:e.settings.chatFocusMode,a=c`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path></svg>`,l=c`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h3"></path><path d="M20 7V4h-3"></path><path d="M4 17v3h3"></path><path d="M20 17v3h-3"></path><circle cx="12" cy="12" r="3"></circle></svg>`;return c`
    <div class="chat-controls">
      <label class="field chat-controls__session">
        <select
          .value=${e.sessionKey}
          ?disabled=${!e.connected}
          @change=${r=>{const p=r.target.value;e.sessionKey=p,e.chatMessage="",e.chatStream=null,e.chatStreamStartedAt=null,e.chatRunId=null,e.resetToolStream(),e.resetChatScroll(),e.applySettings({...e.settings,sessionKey:p,lastActiveSessionKey:p}),e.loadAssistantIdentity(),fd(e,p),Ze(e)}}
        >
          ${ja(t,r=>r.key,r=>c`<option value=${r.key}>
                ${r.displayName??r.key}
              </option>`)}
        </select>
      </label>
      <button
        class="btn btn--sm btn--icon"
        ?disabled=${e.chatLoading||!e.connected}
        @click=${()=>{e.resetToolStream(),Ze(e)}}
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
        ${l}
      </button>
    </div>
  `}function Ah(e,t){const n=new Set,s=[],i=t?.sessions?.find(o=>o.key===e);if(n.add(e),s.push({key:e,displayName:i?.displayName}),t?.sessions)for(const o of t.sessions)n.has(o.key)||(n.add(o.key),s.push({key:o.key,displayName:o.displayName}));return s}const Sh=["system","light","dark"];function _h(e){const t=Math.max(0,Sh.indexOf(e.theme)),n=s=>i=>{const a={element:i.currentTarget};(i.clientX||i.clientY)&&(a.pointerClientX=i.clientX,a.pointerClientY=i.clientY),e.setTheme(s,a)};return c`
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
          ${Eh()}
        </button>
        <button
          class="theme-toggle__button ${e.theme==="light"?"active":""}"
          @click=${n("light")}
          aria-pressed=${e.theme==="light"}
          aria-label="Light theme"
          title="Light"
        >
          ${Th()}
        </button>
        <button
          class="theme-toggle__button ${e.theme==="dark"?"active":""}"
          @click=${n("dark")}
          aria-pressed=${e.theme==="dark"}
          aria-label="Dark theme"
          title="Dark"
        >
          ${Ch()}
        </button>
      </div>
    </div>
  `}function Th(){return c`
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
  `}function Ch(){return c`
    <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"
      ></path>
    </svg>
  `}function Eh(){return c`
    <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect width="20" height="14" x="2" y="3" rx="2"></rect>
      <line x1="8" x2="16" y1="21" y2="21"></line>
      <line x1="12" x2="12" y1="17" y2="21"></line>
    </svg>
  `}const Ih=/^data:/i,Lh=/^https?:\/\//i;function Rh(e){const t=e.agentsList?.agents??[],s=sa(e.sessionKey)?.agentId??e.agentsList?.defaultId??"main",o=t.find(l=>l.id===s)?.identity,a=o?.avatarUrl??o?.avatar;if(a)return Ih.test(a)||Lh.test(a)?a:o?.avatarUrl}function Mh(e){const t=e.presenceEntries.length,n=e.sessionsResult?.count??null,s=e.cronStatus?.nextWakeAtMs??null,i=e.connected?null:"Disconnected from gateway.",o=e.tab==="chat",a=o&&(e.settings.chatFocusMode||e.onboarding),l=e.onboarding?!1:e.settings.chatShowThinking,r=Rh(e),p=e.chatAvatarUrl??r??null;return c`
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
          ${_h(e)}
        </div>
      </header>
      <aside class="nav ${e.settings.navCollapsed?"nav--collapsed":""}">
        ${vl.map(d=>{const u=e.settings.navGroupsCollapsed[d.label]??!1,h=d.tabs.some(v=>v===e.tab);return c`
            <div class="nav-group ${u&&!h?"nav-group--collapsed":""}">
              <button
                class="nav-label"
                @click=${()=>{const v={...e.settings.navGroupsCollapsed};v[d.label]=!u,e.applySettings({...e.settings,navGroupsCollapsed:v})}}
                aria-expanded=${!u}
              >
                <span class="nav-label__text">${d.label}</span>
                <span class="nav-label__chevron">${u?"+":"−"}</span>
              </button>
              <div class="nav-group__items">
                ${d.tabs.map(v=>kh(e,v))}
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
            <div class="page-title">${is(e.tab)}</div>
            <div class="page-sub">${yl(e.tab)}</div>
          </div>
          <div class="page-meta">
            ${e.lastError?c`<div class="pill danger">${e.lastError}</div>`:g}
            ${o?xh(e):g}
          </div>
        </section>

        ${e.tab==="overview"?rh({connected:e.connected,hello:e.hello,settings:e.settings,password:e.password,lastError:e.lastError,presenceCount:t,sessionsCount:n,cronEnabled:e.cronStatus?.enabled??null,cronNext:s,lastChannelsRefresh:e.channelsLastSuccess,onSettingsChange:d=>e.applySettings(d),onPasswordChange:d=>e.password=d,onSessionKeyChange:d=>{e.sessionKey=d,e.chatMessage="",e.resetToolStream(),e.applySettings({...e.settings,sessionKey:d,lastActiveSessionKey:d}),e.loadAssistantIdentity()},onConnect:()=>e.connect(),onRefresh:()=>e.loadOverview()}):g}

        ${e.tab==="channels"?rf({connected:e.connected,loading:e.channelsLoading,snapshot:e.channelsSnapshot,lastError:e.channelsError,lastSuccessAt:e.channelsLastSuccess,whatsappMessage:e.whatsappLoginMessage,whatsappQrDataUrl:e.whatsappLoginQrDataUrl,whatsappConnected:e.whatsappLoginConnected,whatsappBusy:e.whatsappBusy,configSchema:e.configSchema,configSchemaLoading:e.configSchemaLoading,configForm:e.configForm,configUiHints:e.configUiHints,configSaving:e.configSaving,configFormDirty:e.configFormDirty,nostrProfileFormState:e.nostrProfileFormState,nostrProfileAccountId:e.nostrProfileAccountId,onRefresh:d=>oe(e,d),onWhatsAppStart:d=>e.handleWhatsAppStart(d),onWhatsAppWait:()=>e.handleWhatsAppWait(),onWhatsAppLogout:()=>e.handleWhatsAppLogout(),onConfigPatch:(d,u)=>Ot(e,d,u),onConfigSave:()=>e.handleChannelConfigSave(),onConfigReload:()=>e.handleChannelConfigReload(),onNostrProfileEdit:(d,u)=>e.handleNostrProfileEdit(d,u),onNostrProfileCancel:()=>e.handleNostrProfileCancel(),onNostrProfileFieldChange:(d,u)=>e.handleNostrProfileFieldChange(d,u),onNostrProfileSave:()=>e.handleNostrProfileSave(),onNostrProfileImport:()=>e.handleNostrProfileImport(),onNostrProfileToggleAdvanced:()=>e.handleNostrProfileToggleAdvanced()}):g}

        ${e.tab==="instances"?Lf({loading:e.presenceLoading,entries:e.presenceEntries,lastError:e.presenceError,statusMessage:e.presenceStatus,onRefresh:()=>qs(e)}):g}

        ${e.tab==="sessions"?vh({loading:e.sessionsLoading,result:e.sessionsResult,error:e.sessionsError,activeMinutes:e.sessionsFilterActive,limit:e.sessionsFilterLimit,includeGlobal:e.sessionsIncludeGlobal,includeUnknown:e.sessionsIncludeUnknown,basePath:e.basePath,onFiltersChange:d=>{e.sessionsFilterActive=d.activeMinutes,e.sessionsFilterLimit=d.limit,e.sessionsIncludeGlobal=d.includeGlobal,e.sessionsIncludeUnknown=d.includeUnknown},onRefresh:()=>nt(e),onPatch:(d,u)=>Il(e,d,u),onDelete:d=>Ll(e,d)}):g}

        ${e.tab==="cron"?_f({loading:e.cronLoading,status:e.cronStatus,jobs:e.cronJobs,error:e.cronError,busy:e.cronBusy,form:e.cronForm,channels:e.channelsSnapshot?.channelMeta?.length?e.channelsSnapshot.channelMeta.map(d=>d.id):e.channelsSnapshot?.channelOrder??[],channelLabels:e.channelsSnapshot?.channelLabels??{},channelMeta:e.channelsSnapshot?.channelMeta??[],runsJobId:e.cronRunsJobId,runs:e.cronRuns,onFormChange:d=>e.cronForm={...e.cronForm,...d},onRefresh:()=>e.loadCron(),onAdd:()=>Xl(e),onToggle:(d,u)=>ec(e,d,u),onRun:d=>tc(e,d),onRemove:d=>nc(e,d),onLoadRuns:d=>ha(e,d)}):g}

        ${e.tab==="skills"?wh({loading:e.skillsLoading,report:e.skillsReport,error:e.skillsError,filter:e.skillsFilter,edits:e.skillEdits,messages:e.skillMessages,busyKey:e.skillsBusyKey,onFilterChange:d=>e.skillsFilter=d,onRefresh:()=>Tt(e,{clearMessages:!0}),onToggle:(d,u)=>Qc(e,d,u),onEdit:(d,u)=>Yc(e,d,u),onSaveKey:d=>Jc(e,d),onInstall:(d,u,h)=>Zc(e,d,u,h)}):g}

        ${e.tab==="nodes"?Of({loading:e.nodesLoading,nodes:e.nodes,devicesLoading:e.devicesLoading,devicesError:e.devicesError,devicesList:e.devicesList,configForm:e.configForm??e.configSnapshot?.config,configLoading:e.configLoading,configSaving:e.configSaving,configDirty:e.configFormDirty,configFormMode:e.configFormMode,execApprovalsLoading:e.execApprovalsLoading,execApprovalsSaving:e.execApprovalsSaving,execApprovalsDirty:e.execApprovalsDirty,execApprovalsSnapshot:e.execApprovalsSnapshot,execApprovalsForm:e.execApprovalsForm,execApprovalsSelectedAgent:e.execApprovalsSelectedAgent,execApprovalsTarget:e.execApprovalsTarget,execApprovalsTargetNodeId:e.execApprovalsTargetNodeId,onRefresh:()=>un(e),onDevicesRefresh:()=>Se(e),onDeviceApprove:d=>Fc(e,d),onDeviceReject:d=>Uc(e,d),onDeviceRotate:(d,u,h)=>Kc(e,{deviceId:d,role:u,scopes:h}),onDeviceRevoke:(d,u)=>Hc(e,{deviceId:d,role:u}),onLoadConfig:()=>me(e),onLoadExecApprovals:()=>{const d=e.execApprovalsTarget==="node"&&e.execApprovalsTargetNodeId?{kind:"node",nodeId:e.execApprovalsTargetNodeId}:{kind:"gateway"};return js(e,d)},onBindDefault:d=>{d?Ot(e,["tools","exec","node"],d):Xi(e,["tools","exec","node"])},onBindAgent:(d,u)=>{const h=["agents","list",d,"tools","exec","node"];u?Ot(e,h,u):Xi(e,h)},onSaveBindings:()=>cs(e),onExecApprovalsTargetChange:(d,u)=>{e.execApprovalsTarget=d,e.execApprovalsTargetNodeId=u,e.execApprovalsSnapshot=null,e.execApprovalsForm=null,e.execApprovalsDirty=!1,e.execApprovalsSelectedAgent=null},onExecApprovalsSelectAgent:d=>{e.execApprovalsSelectedAgent=d},onExecApprovalsPatch:(d,u)=>Vc(e,d,u),onExecApprovalsRemove:d=>Gc(e,d),onSaveExecApprovals:()=>{const d=e.execApprovalsTarget==="node"&&e.execApprovalsTargetNodeId?{kind:"node",nodeId:e.execApprovalsTargetNodeId}:{kind:"gateway"};return Wc(e,d)}}):g}

        ${e.tab==="chat"?Sp({sessionKey:e.sessionKey,onSessionKeyChange:d=>{e.sessionKey=d,e.chatMessage="",e.chatStream=null,e.chatStreamStartedAt=null,e.chatRunId=null,e.chatQueue=[],e.resetToolStream(),e.resetChatScroll(),e.applySettings({...e.settings,sessionKey:d,lastActiveSessionKey:d}),e.loadAssistantIdentity(),Ze(e),hs(e)},thinkingLevel:e.chatThinkingLevel,showThinking:l,loading:e.chatLoading,sending:e.chatSending,compactionStatus:e.compactionStatus,assistantAvatarUrl:p,messages:e.chatMessages,toolMessages:e.chatToolMessages,stream:e.chatStream,streamStartedAt:e.chatStreamStartedAt,draft:e.chatMessage,queue:e.chatQueue,connected:e.connected,canSend:e.connected,disabledReason:i,error:e.lastError,sessions:e.sessionsResult,focusMode:a,onRefresh:()=>(e.resetToolStream(),Promise.all([Ze(e),hs(e)])),onToggleFocusMode:()=>{e.onboarding||e.applySettings({...e.settings,chatFocusMode:!e.settings.chatFocusMode})},onChatScroll:d=>e.handleChatScroll(d),onDraftChange:d=>e.chatMessage=d,onSend:()=>e.handleSendChat(),canAbort:!!e.chatRunId,onAbort:()=>{e.handleAbortChat()},onQueueRemove:d=>e.removeQueuedMessage(d),onNewSession:()=>e.handleSendChat("/new",{restoreDraft:!0}),sidebarOpen:e.sidebarOpen,sidebarContent:e.sidebarContent,sidebarError:e.sidebarError,splitRatio:e.splitRatio,onOpenSidebar:d=>e.handleOpenSidebar(d),onCloseSidebar:()=>e.handleCloseSidebar(),onSplitRatioChange:d=>e.handleSplitRatioChange(d),assistantName:e.assistantName,assistantAvatar:e.assistantAvatar}):g}

        ${e.tab==="config"?zp({raw:e.configRaw,valid:e.configValid,issues:e.configIssues,loading:e.configLoading,saving:e.configSaving,applying:e.configApplying,updating:e.updateRunning,connected:e.connected,schema:e.configSchema,schemaLoading:e.configSchemaLoading,uiHints:e.configUiHints,formMode:e.configFormMode,formValue:e.configForm,originalValue:e.configFormOriginal,searchQuery:e.configSearchQuery,activeSection:e.configActiveSection,activeSubsection:e.configActiveSubsection,onRawChange:d=>e.configRaw=d,onFormModeChange:d=>e.configFormMode=d,onFormPatch:(d,u)=>Ot(e,d,u),onSearchChange:d=>e.configSearchQuery=d,onSectionChange:d=>{e.configActiveSection=d,e.configActiveSubsection=null},onSubsectionChange:d=>e.configActiveSubsection=d,onReload:()=>me(e),onSave:()=>cs(e),onApply:()=>Yl(e),onUpdate:()=>Ql(e)}):g}

        ${e.tab==="debug"?If({loading:e.debugLoading,status:e.debugStatus,health:e.debugHealth,models:e.debugModels,heartbeat:e.debugHeartbeat,eventLog:e.eventLog,callMethod:e.debugCallMethod,callParams:e.debugCallParams,callResult:e.debugCallResult,callError:e.debugCallError,onCallMethodChange:d=>e.debugCallMethod=d,onCallParamsChange:d=>e.debugCallParams=d,onRefresh:()=>cn(e),onCall:()=>ac(e)}):g}

        ${e.tab==="logs"?Nf({loading:e.logsLoading,error:e.logsError,file:e.logsFile,entries:e.logsEntries,filterText:e.logsFilterText,levelFilters:e.logsLevelFilters,autoFollow:e.logsAutoFollow,truncated:e.logsTruncated,onFilterTextChange:d=>e.logsFilterText=d,onLevelToggle:(d,u)=>{e.logsLevelFilters={...e.logsLevelFilters,[d]:u}},onToggleAutoFollow:d=>e.logsAutoFollow=d,onRefresh:()=>Ds(e,{reset:!0}),onExport:(d,u)=>e.exportLogs(d,u),onScroll:d=>e.handleLogsScroll(d)}):g}
      </main>
      ${yh(e)}
    </div>
  `}const Ph={trace:!0,debug:!0,info:!0,warn:!0,error:!0,fatal:!0},Nh={name:"",description:"",agentId:"",enabled:!0,scheduleKind:"every",scheduleAt:"",everyAmount:"30",everyUnit:"minutes",cronExpr:"0 7 * * *",cronTz:"",sessionTarget:"main",wakeMode:"next-heartbeat",payloadKind:"systemEvent",payloadText:"",deliver:!1,channel:"last",to:"",timeoutSeconds:"",postToMainPrefix:""};async function Oh(e){if(!(!e.client||!e.connected)&&!e.agentsLoading){e.agentsLoading=!0,e.agentsError=null;try{const t=await e.client.request("agents.list",{});t&&(e.agentsList=t)}catch(t){e.agentsError=String(t)}finally{e.agentsLoading=!1}}}const yr={WEBCHAT_UI:"webchat-ui",CONTROL_UI:"clawdbot-control-ui",WEBCHAT:"webchat",CLI:"cli",GATEWAY_CLIENT:"gateway-client",MACOS_APP:"clawdbot-macos",IOS_APP:"clawdbot-ios",ANDROID_APP:"clawdbot-android",NODE_HOST:"node-host",TEST:"test",FINGERPRINT:"fingerprint",PROBE:"clawdbot-probe"},Wo=yr,_s={WEBCHAT:"webchat",CLI:"cli",UI:"ui",BACKEND:"backend",NODE:"node",PROBE:"probe",TEST:"test"};new Set(Object.values(yr));new Set(Object.values(_s));function Dh(e){const t=e.version??(e.nonce?"v2":"v1"),n=e.scopes.join(","),s=e.token??"",i=[t,e.deviceId,e.clientId,e.clientMode,e.role,n,String(e.signedAtMs),s];return t==="v2"&&i.push(e.nonce??""),i.join("|")}const Bh=4008;class Fh{constructor(t){this.opts=t,this.ws=null,this.pending=new Map,this.closed=!1,this.lastSeq=null,this.connectNonce=null,this.connectSent=!1,this.connectTimer=null,this.backoffMs=800}start(){this.closed=!1,this.connect()}stop(){this.closed=!0,this.ws?.close(),this.ws=null,this.flushPending(new Error("gateway client stopped"))}get connected(){return this.ws?.readyState===WebSocket.OPEN}connect(){this.closed||(this.ws=new WebSocket(this.opts.url),this.ws.onopen=()=>this.queueConnect(),this.ws.onmessage=t=>this.handleMessage(String(t.data??"")),this.ws.onclose=t=>{const n=String(t.reason??"");this.ws=null,this.flushPending(new Error(`gateway closed (${t.code}): ${n}`)),this.opts.onClose?.({code:t.code,reason:n}),this.scheduleReconnect()},this.ws.onerror=()=>{})}scheduleReconnect(){if(this.closed)return;const t=this.backoffMs;this.backoffMs=Math.min(this.backoffMs*1.7,15e3),window.setTimeout(()=>this.connect(),t)}flushPending(t){for(const[,n]of this.pending)n.reject(t);this.pending.clear()}async sendConnect(){if(this.connectSent)return;this.connectSent=!0,this.connectTimer!==null&&(window.clearTimeout(this.connectTimer),this.connectTimer=null);const t=typeof crypto<"u"&&!!crypto.subtle,n=["operator.admin","operator.approvals","operator.pairing"],s="operator";let i=null,o=!1,a=this.opts.token;if(t){i=await Ks();const d=Bc({deviceId:i.deviceId,role:s})?.token;a=d??this.opts.token,o=!!(d&&this.opts.token)}const l=a||this.opts.password?{token:a,password:this.opts.password}:void 0;let r;if(t&&i){const d=Date.now(),u=this.connectNonce??void 0,h=Dh({deviceId:i.deviceId,clientId:this.opts.clientName??Wo.CONTROL_UI,clientMode:this.opts.mode??_s.WEBCHAT,role:s,scopes:n,signedAtMs:d,token:a??null,nonce:u}),v=await Oc(i.privateKey,h);r={id:i.deviceId,publicKey:i.publicKey,signature:v,signedAt:d,nonce:u}}const p={minProtocol:3,maxProtocol:3,client:{id:this.opts.clientName??Wo.CONTROL_UI,version:this.opts.clientVersion??"dev",platform:this.opts.platform??navigator.platform??"web",mode:this.opts.mode??_s.WEBCHAT,instanceId:this.opts.instanceId},role:s,scopes:n,device:r,caps:[],auth:l,userAgent:navigator.userAgent,locale:navigator.language};this.request("connect",p).then(d=>{d?.auth?.deviceToken&&i&&La({deviceId:i.deviceId,role:d.auth.role??s,token:d.auth.deviceToken,scopes:d.auth.scopes??[]}),this.backoffMs=800,this.opts.onHello?.(d)}).catch(()=>{o&&i&&Ra({deviceId:i.deviceId,role:s}),this.ws?.close(Bh,"connect failed")})}handleMessage(t){let n;try{n=JSON.parse(t)}catch{return}const s=n;if(s.type==="event"){const i=n;if(i.event==="connect.challenge"){const a=i.payload,l=a&&typeof a.nonce=="string"?a.nonce:null;l&&(this.connectNonce=l,this.sendConnect());return}const o=typeof i.seq=="number"?i.seq:null;o!==null&&(this.lastSeq!==null&&o>this.lastSeq+1&&this.opts.onGap?.({expected:this.lastSeq+1,received:o}),this.lastSeq=o);try{this.opts.onEvent?.(i)}catch(a){console.error("[gateway] event handler error:",a)}return}if(s.type==="res"){const i=n,o=this.pending.get(i.id);if(!o)return;this.pending.delete(i.id),i.ok?o.resolve(i.payload):o.reject(new Error(i.error?.message??"request failed"));return}}request(t,n){if(!this.ws||this.ws.readyState!==WebSocket.OPEN)return Promise.reject(new Error("gateway not connected"));const s=Ns(),i={type:"req",id:s,method:t,params:n},o=new Promise((a,l)=>{this.pending.set(s,{resolve:r=>a(r),reject:l})});return this.ws.send(JSON.stringify(i)),o}queueConnect(){this.connectNonce=null,this.connectSent=!1,this.connectTimer!==null&&window.clearTimeout(this.connectTimer),this.connectTimer=window.setTimeout(()=>{this.sendConnect()},750)}}function Ts(e){return typeof e=="object"&&e!==null}function Uh(e){if(!Ts(e))return null;const t=typeof e.id=="string"?e.id.trim():"",n=e.request;if(!t||!Ts(n))return null;const s=typeof n.command=="string"?n.command.trim():"";if(!s)return null;const i=typeof e.createdAtMs=="number"?e.createdAtMs:0,o=typeof e.expiresAtMs=="number"?e.expiresAtMs:0;return!i||!o?null:{id:t,request:{command:s,cwd:typeof n.cwd=="string"?n.cwd:null,host:typeof n.host=="string"?n.host:null,security:typeof n.security=="string"?n.security:null,ask:typeof n.ask=="string"?n.ask:null,agentId:typeof n.agentId=="string"?n.agentId:null,resolvedPath:typeof n.resolvedPath=="string"?n.resolvedPath:null,sessionKey:typeof n.sessionKey=="string"?n.sessionKey:null},createdAtMs:i,expiresAtMs:o}}function Kh(e){if(!Ts(e))return null;const t=typeof e.id=="string"?e.id.trim():"";return t?{id:t,decision:typeof e.decision=="string"?e.decision:null,resolvedBy:typeof e.resolvedBy=="string"?e.resolvedBy:null,ts:typeof e.ts=="number"?e.ts:null}:null}function wr(e){const t=Date.now();return e.filter(n=>n.expiresAtMs>t)}function Hh(e,t){const n=wr(e).filter(s=>s.id!==t.id);return n.push(t),n}function Vo(e,t){return wr(e).filter(n=>n.id!==t)}async function $r(e,t){if(!e.client||!e.connected)return;const n=e.sessionKey.trim(),s=n?{sessionKey:n}:{};try{const i=await e.client.request("agent.identity.get",s);if(!i)return;const o=ss(i);e.assistantName=o.name,e.assistantAvatar=o.avatar,e.assistantAgentId=o.agentId??null}catch{}}function es(e,t){const n=(e??"").trim(),s=t.mainSessionKey?.trim();if(!s)return n;if(!n)return s;const i=t.mainKey?.trim()||"main",o=t.defaultAgentId?.trim();return n==="main"||n===i||o&&(n===`agent:${o}:main`||n===`agent:${o}:${i}`)?s:n}function zh(e,t){if(!t?.mainSessionKey)return;const n=es(e.sessionKey,t),s=es(e.settings.sessionKey,t),i=es(e.settings.lastActiveSessionKey,t),o=n||s||e.sessionKey,a={...e.settings,sessionKey:s||o,lastActiveSessionKey:i||o},l=a.sessionKey!==e.settings.sessionKey||a.lastActiveSessionKey!==e.settings.lastActiveSessionKey;o!==e.sessionKey&&(e.sessionKey=o),l&&$e(e,a)}function kr(e){e.lastError=null,e.hello=null,e.connected=!1,e.execApprovalQueue=[],e.execApprovalError=null,e.client?.stop(),e.client=new Fh({url:e.settings.gatewayUrl,token:e.settings.token.trim()?e.settings.token:void 0,password:e.password.trim()?e.password:void 0,clientName:"clawdbot-control-ui",mode:"webchat",onHello:t=>{e.connected=!0,e.hello=t,Wh(e,t),$r(e),Oh(e),un(e,{quiet:!0}),Se(e,{quiet:!0}),Js(e)},onClose:({code:t,reason:n})=>{e.connected=!1,e.lastError=`disconnected (${t}): ${n||"no reason"}`},onEvent:t=>jh(e,t),onGap:({expected:t,received:n})=>{e.lastError=`event gap detected (expected seq ${t}, got ${n}); refresh recommended`}}),e.client.start()}function jh(e,t){try{qh(e,t)}catch(n){console.error("[gateway] handleGatewayEvent error:",t.event,n)}}function qh(e,t){if(e.eventLogBuffer=[{ts:Date.now(),event:t.event,payload:t.payload},...e.eventLogBuffer].slice(0,250),e.tab==="debug"&&(e.eventLog=e.eventLogBuffer),t.event==="agent"){if(e.onboarding)return;Kl(e,t.payload);return}if(t.event==="chat"){const n=t.payload;n?.sessionKey&&Ma(e,n.sessionKey);const s=El(e,n);(s==="final"||s==="error"||s==="aborted")&&(Os(e),wd(e)),s==="final"&&Ze(e);return}if(t.event==="presence"){const n=t.payload;n?.presence&&Array.isArray(n.presence)&&(e.presenceEntries=n.presence,e.presenceError=null,e.presenceStatus=null);return}if(t.event==="cron"&&e.tab==="cron"&&Zs(e),(t.event==="device.pair.requested"||t.event==="device.pair.resolved")&&Se(e,{quiet:!0}),t.event==="exec.approval.requested"){const n=Uh(t.payload);if(n){e.execApprovalQueue=Hh(e.execApprovalQueue,n),e.execApprovalError=null;const s=Math.max(0,n.expiresAtMs-Date.now()+500);window.setTimeout(()=>{e.execApprovalQueue=Vo(e.execApprovalQueue,n.id)},s)}return}if(t.event==="exec.approval.resolved"){const n=Kh(t.payload);n&&(e.execApprovalQueue=Vo(e.execApprovalQueue,n.id))}}function Wh(e,t){const n=t.snapshot;n?.presence&&Array.isArray(n.presence)&&(e.presenceEntries=n.presence),n?.health&&(e.debugHealth=n.health),n?.sessionDefaults&&zh(e,n.sessionDefaults)}function Vh(e){e.basePath=rd(),ud(e,!0),ld(e),cd(e),window.addEventListener("popstate",e.popStateHandler),id(e),kr(e),nd(e),e.tab==="logs"&&Vs(e),e.tab==="debug"&&Ys(e)}function Gh(e){Wl(e)}function Yh(e){window.removeEventListener("popstate",e.popStateHandler),sd(e),Gs(e),Qs(e),dd(e),e.topbarObserver?.disconnect(),e.topbarObserver=null}function Qh(e,t){if(e.tab==="chat"&&(t.has("chatMessages")||t.has("chatToolMessages")||t.has("chatStream")||t.has("chatLoading")||t.has("tab"))){const n=t.has("tab"),s=t.has("chatLoading")&&t.get("chatLoading")===!0&&e.chatLoading===!1;rn(e,n||s||!e.chatHasAutoScrolled)}e.tab==="logs"&&(t.has("logsEntries")||t.has("logsAutoFollow")||t.has("tab"))&&e.logsAutoFollow&&e.logsAtBottom&&da(e,t.has("tab")||t.has("logsAutoFollow"))}async function Jh(e,t){await sc(e,t),await oe(e,!0)}async function Zh(e){await ic(e),await oe(e,!0)}async function Xh(e){await oc(e),await oe(e,!0)}async function eg(e){await cs(e),await me(e),await oe(e,!0)}async function tg(e){await me(e),await oe(e,!0)}function ng(e){if(!Array.isArray(e))return{};const t={};for(const n of e){if(typeof n!="string")continue;const[s,...i]=n.split(":");if(!s||i.length===0)continue;const o=s.trim(),a=i.join(":").trim();o&&a&&(t[o]=a)}return t}function xr(e){return(e.channelsSnapshot?.channelAccounts?.nostr??[])[0]?.accountId??e.nostrProfileAccountId??"default"}function Ar(e,t=""){return`/api/channels/nostr/${encodeURIComponent(e)}/profile${t}`}function sg(e,t,n){e.nostrProfileAccountId=t,e.nostrProfileFormState=ef(n??void 0)}function ig(e){e.nostrProfileFormState=null,e.nostrProfileAccountId=null}function og(e,t,n){const s=e.nostrProfileFormState;s&&(e.nostrProfileFormState={...s,values:{...s.values,[t]:n},fieldErrors:{...s.fieldErrors,[t]:""}})}function ag(e){const t=e.nostrProfileFormState;t&&(e.nostrProfileFormState={...t,showAdvanced:!t.showAdvanced})}async function rg(e){const t=e.nostrProfileFormState;if(!t||t.saving)return;const n=xr(e);e.nostrProfileFormState={...t,saving:!0,error:null,success:null,fieldErrors:{}};try{const s=await fetch(Ar(n),{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(t.values)}),i=await s.json().catch(()=>null);if(!s.ok||i?.ok===!1||!i){const o=i?.error??`Profile update failed (${s.status})`;e.nostrProfileFormState={...t,saving:!1,error:o,success:null,fieldErrors:ng(i?.details)};return}if(!i.persisted){e.nostrProfileFormState={...t,saving:!1,error:"Profile publish failed on all relays.",success:null};return}e.nostrProfileFormState={...t,saving:!1,error:null,success:"Profile published to relays.",fieldErrors:{},original:{...t.values}},await oe(e,!0)}catch(s){e.nostrProfileFormState={...t,saving:!1,error:`Profile update failed: ${String(s)}`,success:null}}}async function lg(e){const t=e.nostrProfileFormState;if(!t||t.importing)return;const n=xr(e);e.nostrProfileFormState={...t,importing:!0,error:null,success:null};try{const s=await fetch(Ar(n,"/import"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({autoMerge:!0})}),i=await s.json().catch(()=>null);if(!s.ok||i?.ok===!1||!i){const r=i?.error??`Profile import failed (${s.status})`;e.nostrProfileFormState={...t,importing:!1,error:r,success:null};return}const o=i.merged??i.imported??null,a=o?{...t.values,...o}:t.values,l=!!(a.banner||a.website||a.nip05||a.lud16);e.nostrProfileFormState={...t,importing:!1,values:a,error:null,success:i.saved?"Profile imported from relays. Review and publish.":"Profile imported. Review and publish.",showAdvanced:l},i.saved&&await oe(e,!0)}catch(s){e.nostrProfileFormState={...t,importing:!1,error:`Profile import failed: ${String(s)}`,success:null}}}var cg=Object.defineProperty,dg=Object.getOwnPropertyDescriptor,b=(e,t,n,s)=>{for(var i=s>1?void 0:s?dg(t,n):t,o=e.length-1,a;o>=0;o--)(a=e[o])&&(i=(s?a(t,n,i):a(i))||i);return s&&i&&cg(t,n,i),i};const ts=fl();function ug(){if(!window.location.search)return!1;const t=new URLSearchParams(window.location.search).get("onboarding");if(!t)return!1;const n=t.trim().toLowerCase();return n==="1"||n==="true"||n==="yes"||n==="on"}let m=class extends Qe{constructor(){super(...arguments),this.settings=hl(),this.password="",this.tab="chat",this.onboarding=ug(),this.connected=!1,this.theme=this.settings.theme??"system",this.themeResolved="dark",this.hello=null,this.lastError=null,this.eventLog=[],this.eventLogBuffer=[],this.toolStreamSyncTimer=null,this.sidebarCloseTimer=null,this.assistantName=ts.name,this.assistantAvatar=ts.avatar,this.assistantAgentId=ts.agentId??null,this.sessionKey=this.settings.sessionKey,this.chatLoading=!1,this.chatSending=!1,this.chatMessage="",this.chatMessages=[],this.chatToolMessages=[],this.chatStream=null,this.chatStreamStartedAt=null,this.chatRunId=null,this.compactionStatus=null,this.chatAvatarUrl=null,this.chatThinkingLevel=null,this.chatQueue=[],this.sidebarOpen=!1,this.sidebarContent=null,this.sidebarError=null,this.splitRatio=this.settings.splitRatio,this.nodesLoading=!1,this.nodes=[],this.devicesLoading=!1,this.devicesError=null,this.devicesList=null,this.execApprovalsLoading=!1,this.execApprovalsSaving=!1,this.execApprovalsDirty=!1,this.execApprovalsSnapshot=null,this.execApprovalsForm=null,this.execApprovalsSelectedAgent=null,this.execApprovalsTarget="gateway",this.execApprovalsTargetNodeId=null,this.execApprovalQueue=[],this.execApprovalBusy=!1,this.execApprovalError=null,this.configLoading=!1,this.configRaw=`{
}
`,this.configValid=null,this.configIssues=[],this.configSaving=!1,this.configApplying=!1,this.updateRunning=!1,this.applySessionKey=this.settings.lastActiveSessionKey,this.configSnapshot=null,this.configSchema=null,this.configSchemaVersion=null,this.configSchemaLoading=!1,this.configUiHints={},this.configForm=null,this.configFormOriginal=null,this.configFormDirty=!1,this.configFormMode="form",this.configSearchQuery="",this.configActiveSection=null,this.configActiveSubsection=null,this.channelsLoading=!1,this.channelsSnapshot=null,this.channelsError=null,this.channelsLastSuccess=null,this.whatsappLoginMessage=null,this.whatsappLoginQrDataUrl=null,this.whatsappLoginConnected=null,this.whatsappBusy=!1,this.nostrProfileFormState=null,this.nostrProfileAccountId=null,this.presenceLoading=!1,this.presenceEntries=[],this.presenceError=null,this.presenceStatus=null,this.agentsLoading=!1,this.agentsList=null,this.agentsError=null,this.sessionsLoading=!1,this.sessionsResult=null,this.sessionsError=null,this.sessionsFilterActive="",this.sessionsFilterLimit="120",this.sessionsIncludeGlobal=!0,this.sessionsIncludeUnknown=!1,this.cronLoading=!1,this.cronJobs=[],this.cronStatus=null,this.cronError=null,this.cronForm={...Nh},this.cronRunsJobId=null,this.cronRuns=[],this.cronBusy=!1,this.skillsLoading=!1,this.skillsReport=null,this.skillsError=null,this.skillsFilter="",this.skillEdits={},this.skillsBusyKey=null,this.skillMessages={},this.debugLoading=!1,this.debugStatus=null,this.debugHealth=null,this.debugModels=[],this.debugHeartbeat=null,this.debugCallMethod="",this.debugCallParams="{}",this.debugCallResult=null,this.debugCallError=null,this.logsLoading=!1,this.logsError=null,this.logsFile=null,this.logsEntries=[],this.logsFilterText="",this.logsLevelFilters={...Ph},this.logsAutoFollow=!0,this.logsTruncated=!1,this.logsCursor=null,this.logsLastFetchAt=null,this.logsLimit=500,this.logsMaxBytes=25e4,this.logsAtBottom=!0,this.client=null,this.chatScrollFrame=null,this.chatScrollTimeout=null,this.chatHasAutoScrolled=!1,this.chatUserNearBottom=!0,this.nodesPollInterval=null,this.logsPollInterval=null,this.debugPollInterval=null,this.logsScrollFrame=null,this.toolStreamById=new Map,this.toolStreamOrder=[],this.basePath="",this.popStateHandler=()=>pd(this),this.themeMedia=null,this.themeMediaHandler=null,this.topbarObserver=null}createRenderRoot(){return this}connectedCallback(){super.connectedCallback(),Vh(this)}firstUpdated(){Gh(this)}disconnectedCallback(){Yh(this),super.disconnectedCallback()}updated(e){Qh(this,e)}connect(){kr(this)}handleChatScroll(e){Hl(this,e)}handleLogsScroll(e){zl(this,e)}exportLogs(e,t){ql(e,t)}resetToolStream(){Os(this)}resetChatScroll(){jl(this)}async loadAssistantIdentity(){await $r(this)}applySettings(e){$e(this,e)}setTab(e){od(this,e)}setTheme(e,t){ad(this,e,t)}async loadOverview(){await Oa(this)}async loadCron(){await Zs(this)}async handleAbortChat(){await Ba(this)}removeQueuedMessage(e){md(this,e)}async handleSendChat(e,t){await bd(this,e,t)}async handleWhatsAppStart(e){await Jh(this,e)}async handleWhatsAppWait(){await Zh(this)}async handleWhatsAppLogout(){await Xh(this)}async handleChannelConfigSave(){await eg(this)}async handleChannelConfigReload(){await tg(this)}handleNostrProfileEdit(e,t){sg(this,e,t)}handleNostrProfileCancel(){ig(this)}handleNostrProfileFieldChange(e,t){og(this,e,t)}async handleNostrProfileSave(){await rg(this)}async handleNostrProfileImport(){await lg(this)}handleNostrProfileToggleAdvanced(){ag(this)}async handleExecApprovalDecision(e){const t=this.execApprovalQueue[0];if(!(!t||!this.client||this.execApprovalBusy)){this.execApprovalBusy=!0,this.execApprovalError=null;try{await this.client.request("exec.approval.resolve",{id:t.id,decision:e}),this.execApprovalQueue=this.execApprovalQueue.filter(n=>n.id!==t.id)}catch(n){this.execApprovalError=`Exec approval failed: ${String(n)}`}finally{this.execApprovalBusy=!1}}}handleOpenSidebar(e){this.sidebarCloseTimer!=null&&(window.clearTimeout(this.sidebarCloseTimer),this.sidebarCloseTimer=null),this.sidebarContent=e,this.sidebarError=null,this.sidebarOpen=!0}handleCloseSidebar(){this.sidebarOpen=!1,this.sidebarCloseTimer!=null&&window.clearTimeout(this.sidebarCloseTimer),this.sidebarCloseTimer=window.setTimeout(()=>{this.sidebarOpen||(this.sidebarContent=null,this.sidebarError=null,this.sidebarCloseTimer=null)},200)}handleSplitRatioChange(e){const t=Math.max(.4,Math.min(.7,e));this.splitRatio=t,this.applySettings({...this.settings,splitRatio:t})}render(){return Mh(this)}};b([y()],m.prototype,"settings",2);b([y()],m.prototype,"password",2);b([y()],m.prototype,"tab",2);b([y()],m.prototype,"onboarding",2);b([y()],m.prototype,"connected",2);b([y()],m.prototype,"theme",2);b([y()],m.prototype,"themeResolved",2);b([y()],m.prototype,"hello",2);b([y()],m.prototype,"lastError",2);b([y()],m.prototype,"eventLog",2);b([y()],m.prototype,"assistantName",2);b([y()],m.prototype,"assistantAvatar",2);b([y()],m.prototype,"assistantAgentId",2);b([y()],m.prototype,"sessionKey",2);b([y()],m.prototype,"chatLoading",2);b([y()],m.prototype,"chatSending",2);b([y()],m.prototype,"chatMessage",2);b([y()],m.prototype,"chatMessages",2);b([y()],m.prototype,"chatToolMessages",2);b([y()],m.prototype,"chatStream",2);b([y()],m.prototype,"chatStreamStartedAt",2);b([y()],m.prototype,"chatRunId",2);b([y()],m.prototype,"compactionStatus",2);b([y()],m.prototype,"chatAvatarUrl",2);b([y()],m.prototype,"chatThinkingLevel",2);b([y()],m.prototype,"chatQueue",2);b([y()],m.prototype,"sidebarOpen",2);b([y()],m.prototype,"sidebarContent",2);b([y()],m.prototype,"sidebarError",2);b([y()],m.prototype,"splitRatio",2);b([y()],m.prototype,"nodesLoading",2);b([y()],m.prototype,"nodes",2);b([y()],m.prototype,"devicesLoading",2);b([y()],m.prototype,"devicesError",2);b([y()],m.prototype,"devicesList",2);b([y()],m.prototype,"execApprovalsLoading",2);b([y()],m.prototype,"execApprovalsSaving",2);b([y()],m.prototype,"execApprovalsDirty",2);b([y()],m.prototype,"execApprovalsSnapshot",2);b([y()],m.prototype,"execApprovalsForm",2);b([y()],m.prototype,"execApprovalsSelectedAgent",2);b([y()],m.prototype,"execApprovalsTarget",2);b([y()],m.prototype,"execApprovalsTargetNodeId",2);b([y()],m.prototype,"execApprovalQueue",2);b([y()],m.prototype,"execApprovalBusy",2);b([y()],m.prototype,"execApprovalError",2);b([y()],m.prototype,"configLoading",2);b([y()],m.prototype,"configRaw",2);b([y()],m.prototype,"configValid",2);b([y()],m.prototype,"configIssues",2);b([y()],m.prototype,"configSaving",2);b([y()],m.prototype,"configApplying",2);b([y()],m.prototype,"updateRunning",2);b([y()],m.prototype,"applySessionKey",2);b([y()],m.prototype,"configSnapshot",2);b([y()],m.prototype,"configSchema",2);b([y()],m.prototype,"configSchemaVersion",2);b([y()],m.prototype,"configSchemaLoading",2);b([y()],m.prototype,"configUiHints",2);b([y()],m.prototype,"configForm",2);b([y()],m.prototype,"configFormOriginal",2);b([y()],m.prototype,"configFormDirty",2);b([y()],m.prototype,"configFormMode",2);b([y()],m.prototype,"configSearchQuery",2);b([y()],m.prototype,"configActiveSection",2);b([y()],m.prototype,"configActiveSubsection",2);b([y()],m.prototype,"channelsLoading",2);b([y()],m.prototype,"channelsSnapshot",2);b([y()],m.prototype,"channelsError",2);b([y()],m.prototype,"channelsLastSuccess",2);b([y()],m.prototype,"whatsappLoginMessage",2);b([y()],m.prototype,"whatsappLoginQrDataUrl",2);b([y()],m.prototype,"whatsappLoginConnected",2);b([y()],m.prototype,"whatsappBusy",2);b([y()],m.prototype,"nostrProfileFormState",2);b([y()],m.prototype,"nostrProfileAccountId",2);b([y()],m.prototype,"presenceLoading",2);b([y()],m.prototype,"presenceEntries",2);b([y()],m.prototype,"presenceError",2);b([y()],m.prototype,"presenceStatus",2);b([y()],m.prototype,"agentsLoading",2);b([y()],m.prototype,"agentsList",2);b([y()],m.prototype,"agentsError",2);b([y()],m.prototype,"sessionsLoading",2);b([y()],m.prototype,"sessionsResult",2);b([y()],m.prototype,"sessionsError",2);b([y()],m.prototype,"sessionsFilterActive",2);b([y()],m.prototype,"sessionsFilterLimit",2);b([y()],m.prototype,"sessionsIncludeGlobal",2);b([y()],m.prototype,"sessionsIncludeUnknown",2);b([y()],m.prototype,"cronLoading",2);b([y()],m.prototype,"cronJobs",2);b([y()],m.prototype,"cronStatus",2);b([y()],m.prototype,"cronError",2);b([y()],m.prototype,"cronForm",2);b([y()],m.prototype,"cronRunsJobId",2);b([y()],m.prototype,"cronRuns",2);b([y()],m.prototype,"cronBusy",2);b([y()],m.prototype,"skillsLoading",2);b([y()],m.prototype,"skillsReport",2);b([y()],m.prototype,"skillsError",2);b([y()],m.prototype,"skillsFilter",2);b([y()],m.prototype,"skillEdits",2);b([y()],m.prototype,"skillsBusyKey",2);b([y()],m.prototype,"skillMessages",2);b([y()],m.prototype,"debugLoading",2);b([y()],m.prototype,"debugStatus",2);b([y()],m.prototype,"debugHealth",2);b([y()],m.prototype,"debugModels",2);b([y()],m.prototype,"debugHeartbeat",2);b([y()],m.prototype,"debugCallMethod",2);b([y()],m.prototype,"debugCallParams",2);b([y()],m.prototype,"debugCallResult",2);b([y()],m.prototype,"debugCallError",2);b([y()],m.prototype,"logsLoading",2);b([y()],m.prototype,"logsError",2);b([y()],m.prototype,"logsFile",2);b([y()],m.prototype,"logsEntries",2);b([y()],m.prototype,"logsFilterText",2);b([y()],m.prototype,"logsLevelFilters",2);b([y()],m.prototype,"logsAutoFollow",2);b([y()],m.prototype,"logsTruncated",2);b([y()],m.prototype,"logsCursor",2);b([y()],m.prototype,"logsLastFetchAt",2);b([y()],m.prototype,"logsLimit",2);b([y()],m.prototype,"logsMaxBytes",2);b([y()],m.prototype,"logsAtBottom",2);m=b([ta("clawdbot-app")],m);
//# sourceMappingURL=index-DsXRcnEw.js.map
