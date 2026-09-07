import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { summarizeUsage, emptyUsageCounts } from '../usage-metrics.js';

const owner = { email: 'maxethis@gmail.com', emailVerified: true, providerData: [{providerId:'password'}] };
const source = fs.readFileSync(new URL('../admin-analytics.js', import.meta.url), 'utf8').replace(/^import[^\n]+\n/, '');
const turns = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };
function element(value = '') {
  return { value, textContent:'', hidden:false, disabled:false, style:{}, dataset:{}, children:[], listeners:{},
    addEventListener(event, fn) { this.listeners[event]=fn; },
    replaceChildren(...items) { this.children = items; }, appendChild(item) { this.children.push(item); },
    setAttribute(key, value) { this[key]=value; },
  };
}
function harness({ link, linkValid = true, completeLink, getPage } = {}) {
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, element(id==='baser-usage-days'?'7':'')); return nodes.get(id); };
  const metrics = ['visitors','sessions','exports'].map(name => { const el=element();el.dataset.usageMetric=name;return el; });
  const emails = [], signins = [], events = [], queries = [];
  let listener;
  let signouts = 0;
  const auth = { currentUser:null, onAuthStateChanged(fn) {listener=fn;},
    async sendSignInLinkToEmail(email, settings) {emails.push({email, settings});},
    isSignInWithEmailLink: () => linkValid,
    async signInWithEmailLink(email, value) {signins.push({email,value}); if(completeLink) await completeLink(); auth.currentUser=owner;listener(owner);return {user:owner};},
    async signOut() {signouts++;auth.currentUser=null;listener?.(null);},
  };
  const store = { collection(name) {
    const details={collection:name};
    const query={where(...args){details.where=args;return query;},orderBy(...args){details.orderBy=args;return query;},limit(value){details.limit=value;return query;},startAfter(cursor){details.cursor=cursor;return query;},async get(){queries.push(details);return getPage?getPage(queries.length,details):{size:0,docs:[],forEach(){}};}};
    return query;
  } };
  const apps=[];
  const app={name:'baser-admin',auth:()=>auth,firestore:()=>store,appCheck:()=>({activate(){}})};
  const firebase={apps,initializeApp(_config,name){assert.equal(name,'baser-admin');apps.push(app);return app;},firestore:{Timestamp:{fromMillis:v=>v}}};
  const window={FIREBASE_CONFIG:{projectId:'fixture'},dispatchEvent:event=>events.push(event.type), ...(link?{BASER_USAGE_SIGNIN_LINK:link}:{})};
  const context=vm.createContext({firebase,window,location:{href:'https://maxmendelson.com/?unrelated=1#admin'},URL,Date,Event,summarizeUsage,console,
    document:{getElementById:node,querySelectorAll:()=>metrics,createElement:()=>element()},
  });
  vm.runInContext(source,context);
  return {window,node,metrics,emails,signins,events,queries,auth, apps, get signouts(){return signouts;},notify(user){auth.currentUser=user;listener?.(user);} };
}
const idle=harness();
assert.equal(idle.apps.length,0,'normal page load does not initialize administrator auth');
idle.window.BaserAdminAnalytics.enter();
assert.equal(idle.emails.length,0,'opening analytics never sends email');
await idle.node('baser-usage-signin').listeners.click();
assert.equal(idle.emails.length,1);
assert.equal(idle.emails[0].email,'maxethis@gmail.com');
assert.equal(idle.emails[0].settings.url,'https://maxmendelson.com/?baserUsage=1');
assert.equal(idle.emails[0].settings.handleCodeInApp,true);
assert.equal(idle.node('baser-usage-signin').disabled,false);

const link='https://maxmendelson.com/?mode=signIn&oobCode=fixture';
const linked=harness({link});
await turns();
assert.equal(linked.emails.length,0,'returning from a link never sends another email');
assert.equal(linked.signins.length,1);
assert.equal(linked.signins[0].value,link,'completion uses the link captured before URL cleanup');
assert.equal('BASER_USAGE_SIGNIN_LINK' in linked.window,false,'one-use credential removed from window');
assert(linked.events.includes('baser-usage-signed-in'));
linked.window.BaserAdminAnalytics.enter();
assert.equal(linked.signins.length,1,'initialization cannot reuse the one-use link');
const expired=harness({link,completeLink:async()=>{throw new Error('expired');}});
await turns();
assert.match(expired.node('baser-usage-status').textContent,/expired/);
assert.equal(expired.emails.length,0);
assert(!expired.events.includes('baser-usage-signed-in'));
const malformed=harness({link,linkValid:false});
assert.equal(malformed.signins.length,0);
assert.equal('BASER_USAGE_SIGNIN_LINK' in malformed.window,false);

let finishLink;
const late=harness({link,completeLink:()=>new Promise(resolve=>{finishLink=resolve;})});
await late.window.BaserAdminAnalytics.signOut();
finishLink();
await turns();
assert.equal(late.auth.currentUser,null,'sign-out cancels a pending sign-in completion');
assert(!late.events.includes('baser-usage-signed-in'));
assert.equal(late.metrics[0].textContent,'—');

const now=Date.now();
const documents=Array.from({length:501},(_,i)=>({id:String(i),data:()=>({visitorId:`browser-${i}`,startedAt:now-1000,lastActiveAt:now-1000,activeSeconds:60,...emptyUsageCounts(),export_success:1})}));
const paged=harness({getPage:(count,query)=>{
  assert.equal(query.collection,'baserUsageSessions');assert.equal(query.limit,500);
  const docs=count===1?documents.slice(0,500):documents.slice(500);
  if(count===2)assert.equal(query.cursor,documents[499]);
  return {size:docs.length,docs,forEach:fn=>docs.forEach(fn)};
}});
paged.window.BaserAdminAnalytics.enter();
paged.auth.currentUser=owner;
await paged.window.BaserAdminAnalytics.refresh();
assert.equal(paged.queries.length,2,'all pages are counted');
assert.equal(paged.metrics.find(el=>el.dataset.usageMetric==='sessions').textContent,'501');
assert.equal(paged.metrics.find(el=>el.dataset.usageMetric==='exports').textContent,'501');

let finishRead;
const cancelled=harness({getPage:()=>new Promise(resolve=>{finishRead=resolve;})});
cancelled.window.BaserAdminAnalytics.enter();
cancelled.auth.currentUser=owner;
const refreshing=cancelled.window.BaserAdminAnalytics.refresh();
await cancelled.window.BaserAdminAnalytics.signOut();
finishRead({size:1,docs:[documents[0]],forEach:fn=>fn(documents[0])});
await refreshing;
assert.equal(cancelled.metrics[0].textContent,'—','a late query cannot restore private metrics after sign-out');

// The inline head script must remove credential parameters before external assets.
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const head=html.match(/<head>\s*<script>([\s\S]*?)<\/script>/)[1];
const location={href:'https://maxmendelson.com/?mode=signIn&oobCode=fixture&apiKey=public&lang=en&continueUrl=encoded&authType=x&baserUsage=1&keep=1#admin'};
const memory={};let replacements=0;
const headContext=vm.createContext({URL,location,window:memory,history:{replaceState(_state,_title,url){replacements++;location.href=new URL(url,location.href).href;}}});
vm.runInContext(head,headContext);
assert(memory.BASER_USAGE_SIGNIN_LINK.includes('oobCode=fixture'));
assert.equal(location.href,'https://maxmendelson.com/?keep=1#admin');
vm.runInContext(head,headContext);
assert.equal(replacements,1,'the cleaned URL cannot trigger credential recapture');
console.log('Admin analytics tests passed: explicit email send, sign-in links, auth cancellation, pagination, query privacy, and early credential stripping.');
