const fs=require('fs');
const vm=require('vm');
const html=fs.readFileSync(__dirname+'/index.html','utf8');
const m=html.match(/<script>([\s\S]*?)<\/script>/);
const code=m[1];
function makeEl(id){return{id,value:'',textContent:'',innerHTML:'',style:{},classList:{add:()=>{},remove:()=>{},toggle:()=>{},contains:()=>false},className:'',setAttribute:()=>{},appendChild:()=>{},focus:()=>{},addEventListener:()=>{},parentElement:null,children:[]};}
const els={};
function getEl(id){if(!els[id])els[id]=makeEl(id);return els[id];}
const ctx={
  localStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},
  sessionStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},
  console:{log:()=>{},error:()=>{}},alert:()=>{},confirm:()=>true,
  document:{documentElement:{setAttribute:()=>{},classList:{add:()=>{}}},getElementById:getEl,querySelector:(s)=>getEl(s.slice(1)),querySelectorAll:()=>[],body:{classList:{add:()=>{}}},createElement:makeEl},
  window:{addEventListener:()=>{},localStorage:{getItem:()=>null,setItem:()=>{}},sessionStorage:{getItem:()=>null},location:{}},
  navigator:{},setTimeout:(fn)=>{if(typeof fn==='function')fn();return 0},clearTimeout:()=>{},
  Math,Date,JSON,parseInt,parseFloat,isNaN,isFinite,Object,Array,String,Number,RegExp,Error,Set,Map,Promise
};
vm.createContext(ctx);
vm.runInContext(code,ctx,{timeout:5000});
vm.runInContext('render=()=>{};save=()=>{};closeCustomRedeem=()=>{};renderShop=()=>{};renderStats=()=>{};',ctx);

// DB 在 vm 顶层为 let，外部无法重赋，但可直接改其属性。先取引用。
const DB=vm.runInContext('DB',ctx);
let fails=0;
function assert(cond,msg){if(cond)console.log('OK  ',msg);else{console.log('FAIL',msg);fails++;}}
function resetAll(){vm.runInContext('DB.days={};DB.weightLog=[];DB.redeemLog=[];DB.milestones=[];DB.rescues={};DB.wheelLog=[];DB.dayBuff30={};DB.doubled={};DB.pendingBuffs=[];DB.quest=null;DB.autoRedeem=false;DB.meta.baselineWeight=null;',ctx);}
function runEval(src){return vm.runInContext(src,ctx);}
function buildDay(tasks){ // tasks: {t:[k...], counts:{study45:n,studyDone:n,steps:n}}
  const k=runEval('todayKey()');
  const t={};tasks.t&&tasks.t.forEach(x=>t[x]=true);
  const c={study45:(tasks.counts&&tasks.counts.study45)||0,studyDone:(tasks.counts&&tasks.counts.studyDone)||0,steps:(tasks.counts&&tasks.counts.steps)||0,study45Dev:{},studyDoneDev:{}};
  const d={t,c,resc:[],w:{},wt:null,ld:{}};
  runEval(`DB.days[${JSON.stringify(k)}]=${JSON.stringify(d)};`);
  return k;
}

// ========= 不变式 1：纯任务日（非周日无转盘无兑换无里程碑） totalBalance === dayContribution =========
function sc1(){
  resetAll();
  const k=buildDay({t:['exercise15','noSugar'],counts:{steps:8000}});
  // totalBalance = ΣdayNet (+weekly+milestone+redeem+wheel) 。单日周末=周内非周日不触发周结算、无周任务完成时 dayWeeklySum=0。
  const tb=runEval('totalBalance()');
  // dayContribution=dayNet+dayWeeklySum+0+0+wheelDirectPts
  const dc=runEval('dayContribution(todayKey())');
  assert(Math.abs(tb-dc)<1e-9,`S1 纯任务 对账: balance=${tb} contribution=${dc} 应相等`);
}
sc1();

// ========= 场景 2：基础任务 + 转盘【积分奖励+4G】直接到账（非 buff） =========
function sc2(){
  resetAll();
  buildDay({t:['exercise15','noSugar'],counts:{steps:8000}});
  const k=runEval('todayKey()');
  const tb0=runEval('totalBalance()');
  runEval(`DB.wheelLog.push({id:uid(),kind:'draw',ts:Date.now(),date:${JSON.stringify(k)},n:'积分奖励',g:4});`);
  const tb1=runEval('totalBalance()');
  const direct=runEval('wheelDirectPts(todayKey())');
  assert(Math.abs((tb1-tb0)-4)<1e-9,`S2 积分奖励+4: balance ${tb0}->${tb1} (+${(tb1-tb0)}), wheelDirect=${direct} 应+4`);
  const chip=runEval('wheelGainPts(todayKey())');
  assert(Math.abs((tb1-tb0)-chip)<1e-9,`S2 chip(=wheelGainPts)=${chip} 应等于实际新增 +${(tb1-tb0)}`);
}
sc2();

// ========= 场景 3：日积月累 +15%：基础分正常<50 时,新增=round(base*0.15) =========
function sc3(){
  resetAll();
  const k=buildDay({t:['exercise15','noSugar'],counts:{steps:8000}});
  const basePts=runEval('dayCapBreakdown(todayKey()).normal+dayCapBreakdown(todayKey()).full');
  runEval(`DB.dayBuff30[${JSON.stringify(k)}]=true;`);
  const tb0=runEval('totalBalance()');
  // 再 toggle 一次不会改变(已经是buff)。直接看 breakdown
  const s=runEval('dayCapBreakdown(todayKey())');
  const expected=Math.round(basePts*0.15);
  assert(s.buff30===expected,`S3 dayBuff30: base=${basePts} 期望+15%=${expected}, 实际 bonus/buff30=${s.bonus}/${s.buff30}`);
  const chip=runEval('wheelGainPts(todayKey())');
  assert(Math.abs(chip-(expected+0))<1e-9,`S3 chip=${chip} 应=纯15%加成 ${expected}`);
}
sc3();

// ========= 场景 4：经验暴击×2 on study45（计数翻倍只 +10 bonus，非 count×10） =========
function sc4(){
  resetAll();
  const k=buildDay({t:[],counts:{study45:2,steps:0}}); // 学了2次=20G基础
  const s0=runEval('dayCapBreakdown(todayKey())');
  // 施加 buff：先入队再触发 maybeConsumeNext('study45')
  runEval('DB.pendingBuffs=["any"];maybeConsumeNext("study45")');
  const s1=runEval('dayCapBreakdown(todayKey())');
  const doubled=runEval('DB.doubled[todayKey()]||[]');
  assert(s1.full===20&&s1.bonus===10,`S4 study45×2次+暴击: full=${s1.full}(应20) bonus=${s1.bonus}(应+10)`);  // 暴击只多加1份10
  assert(doubled.length===1,`S4 doubled 记录1条, got ${doubled.length}`);
  // chip 只算新增 bonus 那1份，不含基础 full
  const chip=runEval('wheelGainPts(todayKey())');
  assert(Math.abs(chip-10)<1e-9,`S4 chip=${chip} 应只=暴击新增10`);
}
sc4();

// ========= 场景 5：连续两次暴击 → 勾两个不同任务各消耗一条（队列FIFO） =========
function sc5(){
  resetAll();
  const k=buildDay({t:['exercise15','noSugar']});
  runEval('DB.pendingBuffs=["any","any"];');
  runEval('maybeConsumeNext("exercise15")'); // 消耗一条 any
  runEval('maybeConsumeNext("noSugar")');    // 再消耗一条 any
  const q=runEval('DB.pendingBuffs');
  const arr=runEval('DB.doubled[todayKey()]||[]');
  assert(q.length===0,`S5 两buff两任务后队列清空, remaining=${q.length}`);
  assert(arr.length===2,`S5 doubled 记2任务, got ${arr.length}`);
  // bonus: exercise15+noSugar 各多一份
  const s=runEval('dayCapBreakdown(todayKey())');
  const e1=runEval('taskBasePts(todayKey(),"exercise15")'), e2=runEval('taskBasePts(todayKey(),"noSugar")');
  assert(Math.abs(s.bonus-(e1+e2))<1e-9,`S5 bonus=${s.bonus} 应=${e1+e2}`);
}
sc5();

// ========= 场景 6：同任务重复勾（回弹/取消再勾）不重复消耗 buff 也不重复 bonus =========
function sc6(){
  resetAll();
  const k=buildDay({t:['exercise15']});
  runEval('DB.pendingBuffs=["any"];');
  const consumed1=runEval('maybeConsumeNext("exercise15")'); // 消耗唯一 buff
  const q1=runEval('DB.pendingBuffs.length');                 // 0
  const again=runEval('maybeConsumeNext("exercise15")');      // 同任务无 buff 再勾
  const q2=runEval('DB.pendingBuffs.length');
  // 关键断言：无重复 bonus（doubled 只1条）、不会把已无 buff 误判为消费
  const arr=runEval('DB.doubled[todayKey()]||[]');
  assert(consumed1===true&&again===false,`S6 首次消耗=${consumed1} 二次(同任务无buff)=${again} 应 true/false`);
  assert(q1===0&&q2===0&&arr.length===1,`S6 队列 ${q1}->${q2}, doubled=${arr.length} 应 0->0 / 1`);
}
sc6();

// ========= 场景 6b：同任务已有 buff 覆盖后再勾同任务——不重复消耗队列，bonus 不翻倍累积 =========
function sc6b(){
  resetAll();
  const k=buildDay({t:['exercise15']});
  runEval('DB.pendingBuffs=["any","any"];'); // 两条 any
  runEval('maybeConsumeNext("exercise15")'); // 消耗1条 -> doubled[exercise15]
  const again=runEval('maybeConsumeNext("exercise15")'); // 同任务再勾 -> false(同任务已翻倍,保护)
  const q=runEval('DB.pendingBuffs.length'); // 应剩1条
  const s=runEval('dayCapBreakdown(todayKey())');
  assert(again===false&&q===1,`S6b 同任务二勾: 二次=${again} 队列应剩1 实际剩${q}`);
  const e=runEval('taskBasePts(todayKey(),"exercise15")');
  assert(Math.abs(s.bonus-e)<1e-9,`S6b bonus=${s.bonus} 应只加1份${e}(不叠加×2×2)`);
}
sc6b();

// ========= 场景 7：取消勾选撤销翻倍（revokeBuff）→ bonus归0 & buff行删除 =========
function sc7(){
  resetAll();
  const k=buildDay({t:['exercise15']});
  runEval('DB.pendingBuffs=["any"];maybeConsumeNext("exercise15");');
  const logLen1=runEval('DB.wheelLog.length');
  runEval('revokeBuff("exercise15")');
  const s=runEval('dayCapBreakdown(todayKey())');
  const logLen2=runEval('DB.wheelLog.length');
  assert(s.bonus===0&&logLen2===logLen1-1,`S7 撤销: bonus=${s.bonus} 日志 ${logLen1}->${logLen2}`);
}
sc7();

// ========= 场景 8：暴击 + 日积月累 同时生效——bonus 不再被 15% 二次放大 =========
function sc8(){
  resetAll();
  const k=buildDay({t:['exercise15','noSugar','earlyRise'],counts:{steps:8000}});
  runEval('DB.pendingBuffs=["any"];DB.dayBuff30['+JSON.stringify(k)+']=true;');
  runEval('maybeConsumeNext("exercise15")'); // 暴击 exercise15
  const s=runEval('dayCapBreakdown(todayKey())');
  const baseOnly=runEval('dayCapBreakdown(todayKey()).normal+dayCapBreakdown(todayKey()).full');
  // buff30 只对 base(不含bonus) 加成
  assert(s.buff30===Math.round(baseOnly*0.15),`S8 buff30=${s.buff30} 期望 base(${baseOnly})×15%=${Math.round(baseOnly*0.15)}`);
  assert(s.bonus>0,`S8 bonus=${s.bonus}>0`);
}
sc8();

// ========= 场景 9：任务很多、基础分>50 触发软上限折半，且暴击/buff30 走全额（不被二次折半） =========
function sc9(){
  resetAll();
  // 构造一大批生活+技能任务把 normal 顶过 50
  const tlist=['exercise15','exercise30','noSugar','earlySleep','earlyRise','faceWash','brushTeeth','shower','trash','deskClean','sinkClean','ointment','neckExercise','ulnarNerve','noTakeout','suppMorn','suppNoon','suppAfternoon','suppEve','suppBed','scrubT','blackhead'];
  const k=buildDay({t:tlist,counts:{steps:8000}});
  const sNo=runEval('dayCapBreakdown(todayKey())');
  runEval('DB.dayBuff30['+JSON.stringify(k)+']=true;DB.pendingBuffs=["any"];maybeConsumeNext("earlySleep");');
  const s=runEval('dayCapBreakdown(todayKey())');
  // normal>50 时 cap 折半；bonus/buff30 全额
  const cap=runEval('(()=>{const n=dayCapBreakdown(todayKey()).normal;return n<=50?n:50+(n-50)*0.5})()');
  // 手工平衡 = cap+full+bonus+buff30
  const manual=cap+s.full+s.bonus+s.buff30;
  const got=runEval('dayCapPts(todayKey())');
  assert(Math.abs(manual-got)<1e-6,`S9 软上限+暴击+buff30: manual=${Math.round(manual*10)/10} got=${got} 应相等`);
  assert(s.bonus===Math.round(runEval('taskBasePts(todayKey(),"earlySleep")')*10)/10,`S9 bonus=${s.bonus} 应为 earlySleep 单份全额`);
}
sc9();

// ========= 场景 10：挑战 quest 完成+20 / 放弃-20 只记一次，且计入余额 =========
function sc10(){
  resetAll();
  buildDay({t:['exercise15']});
  const tb0=runEval('totalBalance()');
  runEval('DB.quest={id:"q1",type:"study30",date:todayKey()};questDone();');
  const tb1=runEval('totalBalance()');
  const logLen=runEval('DB.wheelLog.length');
  assert(Math.abs((tb1-tb0)-20)<1e-9,`S10 quest完成: balance +${tb1-tb0} 应+20`);
  // 幂等：再点一次不应重复
  runEval('questDone();');
  const tb2=runEval('totalBalance()');
  assert(Math.abs(tb2-tb1)<1e-9,`S10 quest幂等: 二次无变化 ${tb2}==${tb1}`);
  // 放弃
  runEval('DB.quest={id:"q2",type:"study30",date:todayKey()};questAbandon();');
  const tb3=runEval('totalBalance()');
  assert(Math.abs((tb3-tb2)+20)<1e-9,`S10 quest放弃: ${tb3-tb2} 应-20`);
}
sc10();

// ========= 场景 11：全账本恒等式 —— 多日混合后 「总余额 = 转盘到账+任务净分+周+称重+里程碑 − 兑换」 内部自洽 =========
function sc11(){
  resetAll();
  // 今天 + 昨天各造一天（昨天用真实 shiftKey）
  const today=runEval('todayKey()');
  const yest=runEval('shiftKey(todayKey(),-1)');
  const mk=(dts)=>{const t={};tlist.forEach(x=>dts.t.includes(x)&&(t[x]=true));return {t,c:{study45:dts.s||0,studyDone:0,steps:dts.st||0,study45Dev:{},studyDoneDev:{}},resc:[],w:{},wt:null,ld:{}};};
  const tlist=['exercise15','noSugar','earlyRise'];
  DB.days[today]={t:{exercise15:true,noSugar:true},c:{study45:0,studyDone:0,steps:8000,study45Dev:{},studyDoneDev:{}},resc:[],w:{},wt:null,ld:{}};
  DB.days[yest]={t:{exercise15:true},c:{study45:1,studyDone:0,steps:0,study45Dev:{},studyDoneDev:{}},resc:[],w:{},wt:null,ld:{}};
  // 昨天触发一次 quest 完成，今天一次直接奖励 + 一次 buff + 一次兑换 -12
  runEval(`DB.wheelLog.push({id:uid(),kind:'quest',ts:Date.now(),questId:'a',date:${JSON.stringify(yest)},n:'加学30分钟·完成',g:20});`);
  runEval(`DB.wheelLog.push({id:uid(),kind:'draw',ts:Date.now(),date:${JSON.stringify(today)},n:'积分奖励',g:3});`);
  DB.dayBuff30[today]=true;
  DB.pendingBuffs=['any']; // 待消费，但今天还没任务可触发? earlyRise没勾; 就不触发，仅当 bonus=0
  runEval(`DB.redeemLog.push({id:uid(),date:${JSON.stringify(today)},n:'测试兑换',c:12});`);
  // 独立累计到账：用代码自身函数累加 dayContribution over 所有有记录日 + quest直接(已在wheelLog) 
  // 验证 identity: 余额 = Σ(dayContribution) - Σredeem  over 今天的+昨天的（dayContribution 已含 wheelDirect）
  // 因 totalBalance 用 dayNet+wheelLog；dayContribution=dayNet+wheelDirect... 用各日求和应与 totalBalance 一致(无周/称重/里程碑干扰下)
  const days=runEval(`[...new Set([...Object.keys(DB.days), ...DB.wheelLog.map(w=>w.date)])].filter(k=>k)`);
  let sum=0;
  days.forEach(k=>{sum+=runEval(`dayContribution(${JSON.stringify(k)})`);});
  const redeemSum=runEval('DB.redeemLog.reduce((s,r)=>s+r.c,0)');
  const bal=runEval('totalBalance()');
  // dayContribution 已减? dayNet 已把 redeem 之外算; 这里 sum 不含 redeem 扣除，故 identity: bal == sum - redeem
  assert(Math.abs((bal-(sum-redeemSum)))<1e-6,`S11 混合账本: 余额=${bal} = Σcontribution(${Math.round(sum*10)/10}) - redeem(${redeemSum})`);
}
sc11();

console.log(fails?`\n${fails} 处失败`:'\n全部通过');
process.exit(fails?1:0);