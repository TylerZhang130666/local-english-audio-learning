const $=id=>document.getElementById(id);
let current='',doc=null,dirty=false,saving=false,generation=0,poll=null,stopAt=null;
async function api(url,data){const r=await fetch(url,data?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{});const j=await r.json();if(!r.ok)throw Error(j.error||'请求失败');return j;}
function time(t,srt=false){const ms=Math.round(t*1000),s=Math.floor(ms/1000);return [Math.floor(s/3600),Math.floor(s/60)%60,s%60].map(x=>String(x).padStart(2,'0')).join(':')+(srt?','+String(ms%1000).padStart(3,'0'):'');}
function changed(){dirty=true;generation++;$('saveStatus').textContent='有未保存修改 · 点击「保存修改」写入本地';$('save').disabled=false;}
async function save(){if(!doc||saving)return false;saving=true;$('save').disabled=true;const g=generation;try{const result=await api('/api/save',{id:current,doc});doc.revision=result.revision;if(g===generation){dirty=false;$('saveStatus').textContent='已保存到本地 · '+new Date().toLocaleTimeString();}return true;}catch(e){$('saveStatus').textContent=e.message;return false;}finally{saving=false;$('save').disabled=!dirty;}}
function render(){const container=$('segments');container.replaceChildren();$('count').textContent=doc?`${doc.segments.length} 句`:'';$('filterSummary').textContent=doc?`👂 听不懂 ${doc.segments.filter(s=>s.listening).length} 句`:'👂 听不懂 0 句';if(!doc){const e=document.createElement('div');e.className='empty';e.textContent='选择录音后开始转录。转录完成后，逐句编辑、收藏并添加笔记。';container.append(e);return;}const query=$('search').value.toLowerCase(),filter=$('filter').value;let shown=0;for(const s of doc.segments){s.listening=!!s.listening;if(filter!=='all'&&!s[filter])continue;if(query&&!(s.text+' '+s.note).toLowerCase().includes(query))continue;shown++;const el=document.createElement('section');el.className='sentence'+(s.highlight?' highlight':'')+(s.listening?' listening':'');el.dataset.id=s.id;const head=document.createElement('div');head.className='sentence-head';const jump=document.createElement('button');jump.className='timestamp';jump.textContent='▶ '+time(s.start);jump.title='从这句话开始播放';jump.onclick=()=>{stopAt=null;$('audio').currentTime=s.start;$('audio').play().catch(e=>$('status').textContent=e.message);};head.append(jump);const tags=document.createElement('div');tags.className='tags';for(const [key,label] of [['listening','👂 听不懂'],['favorite','⭐ 收藏'],['highlight','🟨 待学习']]){const b=document.createElement('button');b.textContent=label;b.setAttribute('aria-pressed',s[key]);b.onclick=()=>{s[key]=!s[key];changed();render();};tags.append(b);}const solo=document.createElement('button');solo.className='solo';solo.textContent='🎧 只听本句';solo.title='只播放这一句，到句尾自动暂停';solo.onclick=()=>{stopAt=s.end;$('audio').currentTime=s.start;$('audio').play().catch(e=>$('status').textContent=e.message);};tags.append(solo);head.append(tags);el.append(head);const text=document.createElement('textarea');text.className='text';text.title='点击这里修改识别文字，改好后点击保存修改';text.value=s.text;text.rows=Math.max(2,Math.ceil(s.text.length/75));text.setAttribute('aria-label',time(s.start)+' 英文逐字稿');text.oninput=()=>{s.text=text.value;changed();};const note=document.createElement('textarea');note.className='note';note.value=s.note;note.rows=1;note.placeholder='写下含义、使用场景，或你想模仿的表达…';note.setAttribute('aria-label',time(s.start)+' 学习笔记');note.oninput=()=>{s.note=note.value;changed();};const editLabel=document.createElement('label');editLabel.className='edit-label';editLabel.textContent='✎ 英文文本 · 点击修改';text.id='transcript-'+s.id;editLabel.htmlFor=text.id;el.append(editLabel,text,note);container.append(el);}if(!shown){container.textContent=doc.segments.length?(filter==='listening'?'还没有标记“听不懂”的句子。':'没有符合筛选条件的句子。'):'未检测到可转录的英语语音。';}}
async function refresh(){try{const list=await api('/api/files');$('files').replaceChildren(new Option('请选择录音',''));for(const f of list)$('files').add(new Option(f.name+(f.ready?' · 已转录':''),f.id));$('files').value=current;$('status').textContent=list.length?`找到 ${list.length} 个录音`:'audio 文件夹还没有录音，放入文件后点击刷新。';}catch(e){$('status').textContent=e.message;}}
async function load(key){clearTimeout(poll);if(!key){doc=null;render();return;}try{const r=await api('/api/doc?id='+key);if(key!==current)return;if(!dirty&&!doc&&r.doc){doc=r.doc;render();$('export').disabled=false;}$('transcribe').disabled=!!doc||r.job?.state==='running';if(r.job){$('status').textContent=r.job.message;$('progress').hidden=r.job.state!=='running';$('progress').value=r.job.progress||0;}else{$('status').textContent=doc?'逐字稿已加载，可以播放和编辑。':'录音已就绪，点击开始英文转录。';$('progress').hidden=true;}if(r.job?.state==='running')poll=setTimeout(()=>load(key),1500);}catch(e){$('status').textContent=e.message;}}
$('files').onchange=async()=>{const key=$('files').value;if(saving){$('files').value=current;return;}if(dirty&&!(await save())){$('files').value=current;return;}current=key;loadBookmarks();doc=null;dirty=false;$('save').disabled=true;$('export').disabled=true;$('transcribe').disabled=!key;$('saveStatus').textContent='编辑后点击保存，写入本地 data 文件夹。导出包含全部句子。';$('audio').pause();$('audio').removeAttribute('src');if(key)$('audio').src='/audio/'+key;$('audio').load();$('audio').playbackRate=Number($('speed').value);$('title').textContent=key?$('files').selectedOptions[0].textContent.replace(/ · 已转录$/,''):'还没有选择录音';render();await load(key);};
$('refresh').onclick=refresh;$('save').onclick=save;
$('transcribe').onclick=async()=>{if(!current)return;$('transcribe').disabled=true;try{await api('/api/transcribe',{id:current});await load(current);}catch(e){$('status').textContent=e.message;$('transcribe').disabled=false;}};
$('back').onclick=()=>{$('audio').currentTime=Math.max(0,$('audio').currentTime-5);};$('forward').onclick=()=>{if(Number.isFinite($('audio').duration))$('audio').currentTime=Math.min($('audio').duration,$('audio').currentTime+5);};$('speed').onchange=()=>{$('audio').playbackRate=Number($('speed').value);};
$('audio').ontimeupdate=()=>{syncSeek();if(stopAt!==null&&$('audio').currentTime>=stopAt-0.04){$('audio').pause();$('audio').currentTime=Math.min(stopAt,$('audio').duration||stopAt);stopAt=null;}if(!scrubbing)followTranscript($('audio').currentTime,false);};
$('audio').onerror=()=>{$('status').textContent='浏览器无法播放此音频。可先尝试转录；播放不兼容时，请将音频转换成 MP3 或 WAV。';};
$('search').oninput=render;$('filter').onchange=render;
$('export').onclick=()=>{if(!doc)return;const format=$('format').value;let content;if(format==='srt'){content=doc.segments.map((s,i)=>`${i+1}\n${time(s.start,true)} --> ${time(s.end,true)}\n${s.text}\n`).join('\n');}else{content=(format==='md'?'# ':'')+doc.name+'\n\n'+doc.segments.map(s=>`${format==='md'?'## ':''}[${time(s.start)}] ${s.favorite?'⭐ ':''}${s.highlight?'[待学习] ':''}\n${s.text}${s.note?'\n\n笔记：'+s.note:''}`).join('\n\n');}const url=URL.createObjectURL(new Blob(['\ufeff'+content],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=doc.name.replace(/\.[^.]+$/,'')+'.'+format;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});refresh();

let scrubbing=false;
function syncSeek(){
  const a=$('audio'),valid=Number.isFinite(a.duration)&&a.duration>0;
  $('seek').disabled=!valid;$('addBookmark').disabled=!valid||!current;
  $('seek').max=valid?a.duration:0;
  $('duration').textContent=time(valid?a.duration:0);
  if(!scrubbing){$('seek').value=valid?a.currentTime:0;$('elapsed').textContent=time(valid?a.currentTime:0);}
  $('seek').setAttribute('aria-valuetext',$('elapsed').textContent+' / '+$('duration').textContent);
}
$('seek').addEventListener('input',()=>{scrubbing=true;$('elapsed').textContent=time(Number($('seek').value));$('seek').setAttribute('aria-valuetext',$('elapsed').textContent+' / '+$('duration').textContent);followTranscript(Number($('seek').value),true);});
$('seek').addEventListener('change',()=>{const a=$('audio');if(Number.isFinite(a.duration))a.currentTime=Math.min(a.duration,Math.max(0,Number($('seek').value)));scrubbing=false;syncSeek();});
$('seek').addEventListener('pointercancel',()=>{scrubbing=false;syncSeek();});
for(const event of ['loadedmetadata','durationchange','emptied','seeked'])$('audio').addEventListener(event,()=>{scrubbing=false;syncSeek();});

let bookmarks=[];
function loadBookmarks(){
  bookmarks=[];
  try{const saved=JSON.parse(localStorage.getItem('listening-bookmarks:'+current)||'[]');if(!Array.isArray(saved))throw Error();bookmarks=saved.filter(b=>typeof b.id==='string'&&Number.isFinite(b.time)&&b.time>=0&&typeof b.note==='string');$('bookmarkStatus').textContent='标记自动保存在当前浏览器；建议导出备份。';}
  catch(e){$('bookmarkStatus').textContent='无法读取浏览器标记，请检查浏览器存储设置。';}
  renderBookmarks();
}
function saveBookmarks(){
  try{localStorage.setItem('listening-bookmarks:'+current,JSON.stringify(bookmarks));$('bookmarkStatus').textContent='位置标记已自动保存到当前浏览器';}
  catch(e){$('bookmarkStatus').textContent='浏览器保存失败，请立即导出位置标记备份。';}
}
function renderBookmarks(){
  $('bookmarkList').replaceChildren();$('exportBookmarks').disabled=!bookmarks.length;
  for(const mark of [...bookmarks].sort((a,b)=>a.time-b.time)){
    const row=document.createElement('div');row.className='bookmark';
    const jump=document.createElement('button');jump.textContent='▶ '+time(mark.time);jump.title='跳到标记位置';jump.onclick=()=>{$('audio').currentTime=mark.time;};
    const note=document.createElement('input');note.value=mark.note;note.placeholder='备注，如：没听懂、老板常用表达';note.setAttribute('aria-label',time(mark.time)+' 位置标记备注');note.oninput=()=>{mark.note=note.value;saveBookmarks();};
    const remove=document.createElement('button');remove.textContent='移除';remove.onclick=()=>{bookmarks=bookmarks.filter(b=>b.id!==mark.id);saveBookmarks();renderBookmarks();};
    row.append(jump,note,remove);$('bookmarkList').append(row);
  }
}
$('addBookmark').onclick=()=>{if(!current)return;bookmarks.push({id:crypto.randomUUID(),time:$('audio').currentTime,note:''});saveBookmarks();renderBookmarks();};
$('exportBookmarks').onclick=()=>{const content='# '+$('title').textContent+' · 录音位置标记\n\n'+[...bookmarks].sort((a,b)=>a.time-b.time).map(b=>'['+time(b.time)+'] '+b.note).join('\n\n');const url=URL.createObjectURL(new Blob(['\ufeff'+content],{type:'text/markdown;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=$('title').textContent+'-位置标记.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};

let lastFollowedRow=null;
function followTranscript(position,scroll){
  if(!doc?.segments.length)return;
  const segments=doc.segments;
  const target=segments.find(s=>s.start<=position&&position<s.end)
    || segments.find(s=>s.start>position) || segments[segments.length-1];
  let row=document.getElementById('transcript-'+target.id)?.closest('.sentence');
  if(!row&&scroll){
    $('search').value='';$('filter').value='all';render();
    row=document.getElementById('transcript-'+target.id)?.closest('.sentence');
  }
  document.querySelectorAll('.sentence').forEach(el=>{
    const selected=Number(el.dataset.id)===target.id;
    el.classList.toggle('active',selected);
    if(selected)el.setAttribute('aria-current','true');else el.removeAttribute('aria-current');
  });
  const editing=document.activeElement?.matches('textarea,input:not([type=range])');
  const autoFollow=!$('audio').paused&&!editing&&row!==lastFollowedRow;
  if(row&&(scroll||autoFollow)){
    row.scrollIntoView({behavior:scroll?'instant':'smooth',block:'center',inline:'nearest'});
    lastFollowedRow=row;
  }
}
$('audio').addEventListener('seeked',()=>followTranscript($('audio').currentTime,true));

$('audio').addEventListener('play',()=>{lastFollowedRow=null;followTranscript($('audio').currentTime,false);});

let boostContext=null,boostGain=null,boostSource=null,boostLimiter=null;
async function applyBoost(){
  const amount=Number($('boost').value);
  $('boostValue').textContent=amount+'×';
  try{
    if(!boostContext&&amount>1){
      const AudioContext=window.AudioContext||window.webkitAudioContext;
      if(!AudioContext)throw Error('当前浏览器不支持音量增强');
      boostContext=new AudioContext();
      boostGain=boostContext.createGain();
      boostLimiter=boostContext.createDynamicsCompressor();
      boostLimiter.threshold.value=-3;boostLimiter.knee.value=3;
      boostLimiter.ratio.value=20;boostLimiter.attack.value=0.003;boostLimiter.release.value=0.2;
      boostSource=boostContext.createMediaElementSource($('audio'));
      boostSource.connect(boostGain);boostGain.connect(boostLimiter);boostLimiter.connect(boostContext.destination);
    }
    if(boostContext){
      boostGain.gain.setTargetAtTime(amount,boostContext.currentTime,0.03);
      if(boostContext.state==='suspended')await boostContext.resume();
    }
    $('boostStatus').textContent=amount>1?'已增强至 '+amount+'×；若出现失真，请降低倍数。':'原始音量；声音较小时可先调到 2×。';
  }catch(e){$('boostStatus').textContent='音量增强未启用：'+e.message;}
}
$('boost').addEventListener('input',applyBoost);
$('audio').addEventListener('play',()=>{if(boostContext)applyBoost();});

// Integrated listening and pronunciation study card.
const WEAK_WORDS=new Set('a an the and or but as at by for from if in into of on to with is am are was were be been being do does did have has had can could will would shall should may might must i me my we us our you your he him his she her it its they them their this that these those there then than so not'.split(' '));
const IPA_HELP={
  'iː':['长音 /iː/','嘴角略向两侧展开，舌位高而靠前；保持声音长度。','see, field'],
  'ɪ':['短音 /ɪ/','舌位比 /iː/ 稍低、稍放松，发音短。','sit, little'],
  'ɛ':['/ɛ/','嘴自然张开，舌位在前部中间。','check, bed'],
  'æ':['/æ/','下颌打开，舌前部压低；不要读成“爱”。','sample, map'],
  'ɑ':['/ɑ/','嘴张开，舌位低而靠后。','hot, model'],
  'ɔ':['/ɔ/','双唇略圆，舌位靠后。','thought, all'],
  'ʌ':['/ʌ/','短促放松，舌位居中偏后。','but, study'],
  'ə':['弱读 /ə/','最放松的中央元音，短而轻；很多非重读音节使用它。','about, feasible'],
  'ɚ':['卷舌弱音 /ɚ/','先发放松的 /ə/，同时轻微卷舌。','teacher, better'],
  'ɝ':['重读卷舌音 /ɝ/','保持中央元音并卷舌，声音更清楚。','word, learn'],
  'ʊ':['/ʊ/','双唇略圆，短促放松。','good, could'],
  'uː':['长音 /uː/','双唇收圆，舌位高而靠后，保持长度。','food, group'],
  'eɪ':['双元音 /eɪ/','从 /e/ 滑向 /ɪ/，不要分成两个音。','day, data'],
  'oʊ':['双元音 /oʊ/','从中后元音滑向 /ʊ/，双唇逐渐收圆。','go, soil'],
  'aɪ':['双元音 /aɪ/','从开口元音平滑滑向 /ɪ/。','time, right'],
  'aʊ':['双元音 /aʊ/','从开口元音滑向圆唇的 /ʊ/。','how, out'],
  'ɔɪ':['双元音 /ɔɪ/','从圆唇的 /ɔ/ 滑向 /ɪ/。','soil, point'],
  'θ':['清辅音 /θ/','舌尖轻放在上下齿之间，让气流通过，不振动声带。','think, method'],
  'ð':['浊辅音 /ð/','位置与 /θ/ 相同，但声带振动。','this, that'],
  'ʃ':['/ʃ/','双唇略圆，舌前部靠近齿龈后方，让气流摩擦。','should, pressure'],
  'ʒ':['/ʒ/','位置接近 /ʃ/，同时振动声带。','measure, vision'],
  'tʃ':['/tʃ/','先短暂阻断气流，再释放为 /ʃ/。','check, feature'],
  'dʒ':['/dʒ/','浊音，先阻断再释放为 /ʒ/。','job, adjust'],
  'ŋ':['/ŋ/','舌后部贴近软腭，气流从鼻腔通过；不要在结尾再加 /g/。','thing, sampling'],
  'r':['美式 /r/','舌尖抬起但不碰上颚，双唇略收。','right, around'],
  'l':['/l/','舌尖碰上齿龈；词尾时舌后部也会抬起。','look, field']
};
let wordContext=null,mediaRecorder=null,recordedChunks=[],recordingUrl=null;

function wordsOf(text){return text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g)||[];}
function normalizedWord(word){return word.toLowerCase().replace(/^[^a-z]+|[^a-z'-]+$/g,'');}
function focusSuggestions(text){
  const words=wordsOf(text),unique=[];
  for(const word of words){const clean=normalizedWord(word);if(clean&&!WEAK_WORDS.has(clean)&&!unique.some(x=>x.clean===clean))unique.push({word,clean,index:unique.length});}
  const count=Math.min(4,Math.max(2,Math.ceil(words.length/6)));
  const strong=unique.sort((a,b)=>b.clean.length-a.clean.length||a.index-b.index).slice(0,count).sort((a,b)=>a.index-b.index).map(x=>x.word);
  const weak=words.filter(word=>WEAK_WORDS.has(normalizedWord(word))).slice(0,8);
  const links=[];
  for(let i=0;i<words.length-1;i++){
    const left=normalizedWord(words[i]),right=normalizedWord(words[i+1]);
    if(left&&right&&/[bcdfghjklmnpqrstvwxyz]$/.test(left)&&/^[aeiou]/.test(right))links.push(words[i]+'‿'+words[i+1]);
  }
  return {strong,weak:[...new Set(weak)],links:links.slice(0,4)};
}
function makeField(label,value,placeholder,oninput,rows=1){
  const wrap=document.createElement('label');wrap.className='study-field';wrap.append(document.createTextNode(label));
  const input=rows>1?document.createElement('textarea'):document.createElement('input');input.value=value;input.placeholder=placeholder;if(rows>1)input.rows=rows;input.oninput=()=>oninput(input.value);wrap.append(input);return wrap;
}
function toggleSentenceStatus(segment,key){
  segment[key]=!segment[key];
  if(key==='mastered'&&segment.mastered){segment.listening=false;segment.speaking=false;segment.mismatch_words=[];}
  if(key!=='mastered'&&segment[key])segment.mastered=false;
  changed();render();
}
function matchesFilter(segment,filter){
  if(filter==='all')return true;
  if(filter==='pronunciation')return segment.mismatch_words.length>0;
  return !!segment[filter];
}
function buildStudyBody(segment,body){
  const suggestion=focusSuggestions(segment.text);
  const strong=(segment.focus_stress||suggestion.strong.join(', ')).split(/[,，/]+/).map(normalizedWord).filter(Boolean);
  const tokenBox=document.createElement('div');tokenBox.className='focus-sentence';
  const pieces=segment.text.match(/[A-Za-z]+(?:'[A-Za-z]+)?|[^A-Za-z]+/g)||[];
  for(const piece of pieces){
    if(!/[A-Za-z]/.test(piece)){tokenBox.append(document.createTextNode(piece));continue;}
    const button=document.createElement('button');button.textContent=strong.includes(normalizedWord(piece))?piece.toUpperCase():piece;button.className=strong.includes(normalizedWord(piece))?'focus-strong':'focus-word';button.title='点击查看 IPA 和录音';button.onclick=()=>openWord(piece,segment);tokenBox.append(button);
  }
  const focus=document.createElement('section');focus.className='study-block';focus.innerHTML='<h4>🎧 Listening Focus <small>自动建议，可修改</small></h4>';focus.append(tokenBox);
  focus.append(
    makeField('建议重读词',segment.focus_stress||suggestion.strong.join(', '),'每句保留 2–4 个',value=>{segment.focus_stress=value;changed();}),
    makeField('建议弱读词',segment.focus_weak||suggestion.weak.join(', '),'如 we have to',value=>{segment.focus_weak=value;changed();}),
    makeField('可能连读',segment.focus_links||suggestion.links.join(', '),'如 check‿if',value=>{segment.focus_links=value;changed();})
  );
  const pronunciation=document.createElement('section');pronunciation.className='study-block';pronunciation.innerHTML='<h4>🔊 Pronunciation Focus</h4><p>点击上方任意单词查看 IPA、重音、音标说明、系统发音和你的录音。</p>';
  const mismatch=document.createElement('p');mismatch.className='mismatch-list';mismatch.textContent=segment.mismatch_words.length?'⚠ 已标记：'+segment.mismatch_words.join(', '):'尚未标记 Pronunciation mismatch';pronunciation.append(mismatch);
  const output=document.createElement('section');output.className='study-block output-block';output.innerHTML='<h4>🧠 Meaning & 🗣 My Response</h4>';
  output.append(
    makeField('中文含义',segment.meaning,'这句话在当前会议中的意思',value=>{segment.meaning=value;changed();},2),
    makeField('My Response',segment.my_response,'如果老板对我说这句话，我会怎样回答？',value=>{segment.my_response=value;changed();},3)
  );
  body.append(focus,pronunciation,output);
}
function render(){
  const container=$('segments');container.replaceChildren();
  $('count').textContent=doc?`${doc.segments.length} 句`:'';
  if(!doc){$('filterSummary').textContent='👂 0 · 🔊 0 · 🗣 0 · ✅ 0';const empty=document.createElement('div');empty.className='empty';empty.textContent='选择录音后开始转录。转录完成后，逐句编辑并练习。';container.append(empty);return;}
  for(const s of doc.segments){s.listening=!!s.listening;s.speaking=!!s.speaking;s.mastered=!!s.mastered;s.meaning=s.meaning||'';s.my_response=s.my_response||'';s.focus_stress=s.focus_stress||'';s.focus_weak=s.focus_weak||'';s.focus_links=s.focus_links||'';s.mismatch_words=Array.isArray(s.mismatch_words)?s.mismatch_words:[];}
  $('filterSummary').textContent=`👂 ${doc.segments.filter(s=>s.listening).length} · 🔊 ${doc.segments.filter(s=>s.mismatch_words.length).length} · 🗣 ${doc.segments.filter(s=>s.speaking).length} · ✅ ${doc.segments.filter(s=>s.mastered).length}`;
  const query=$('search').value.toLowerCase(),filter=$('filter').value;let shown=0;
  for(const s of doc.segments){
    if(!matchesFilter(s,filter))continue;
    if(query&&!(s.text+' '+s.note+' '+s.meaning+' '+s.my_response+' '+s.mismatch_words.join(' ')).toLowerCase().includes(query))continue;
    shown++;
    const el=document.createElement('section');el.className='sentence'+(s.highlight?' highlight':'')+(s.listening?' listening':'')+(s.mismatch_words.length?' pronunciation-issue':'')+(s.mastered?' mastered':'');el.dataset.id=s.id;
    const head=document.createElement('div');head.className='sentence-head';
    const jump=document.createElement('button');jump.className='timestamp';jump.textContent='▶ '+time(s.start);jump.onclick=()=>{stopAt=null;$('audio').currentTime=s.start;$('audio').play().catch(e=>$('status').textContent=e.message);};head.append(jump);
    const tags=document.createElement('div');tags.className='tags';
    for(const [key,label] of [['listening','👂 听不懂'],['speaking','🗣 不会说'],['mastered','✅ 已掌握'],['favorite','⭐ 收藏'],['highlight','🟨 待学习']]){const b=document.createElement('button');b.textContent=label;b.setAttribute('aria-pressed',s[key]);b.onclick=()=>['favorite','highlight'].includes(key)?(s[key]=!s[key],changed(),render()):toggleSentenceStatus(s,key);tags.append(b);}
    const solo=document.createElement('button');solo.className='solo';solo.textContent='🎧 只听本句';solo.onclick=()=>{stopAt=s.end;$('audio').currentTime=s.start;$('audio').play().catch(e=>$('status').textContent=e.message);};tags.append(solo);head.append(tags);el.append(head);
    const text=document.createElement('textarea');text.className='text';text.value=s.text;text.rows=Math.max(2,Math.ceil(s.text.length/75));text.id='transcript-'+s.id;text.setAttribute('aria-label',time(s.start)+' 英文逐字稿');text.oninput=()=>{s.text=text.value;changed();};
    const editLabel=document.createElement('label');editLabel.className='edit-label';editLabel.htmlFor=text.id;editLabel.textContent='✎ 英文文本 · 点击修改';el.append(editLabel,text);
    const suggestion=focusSuggestions(s.text);const preview=document.createElement('p');preview.className='focus-preview';preview.textContent='建议重读：'+(s.focus_stress||suggestion.strong.join(' / ')||'—')+(s.mismatch_words.length?'　⚠ 发音：'+s.mismatch_words.join(', '):'');el.append(preview);
    const details=document.createElement('details');details.className='study-details';const summary=document.createElement('summary');summary.textContent='展开：发音 + 听力重点 / Meaning / My Response';const body=document.createElement('div');body.className='study-body';details.append(summary,body);details.ontoggle=()=>{if(details.open&&!body.childElementCount)buildStudyBody(s,body);};el.append(details);
    const note=makeField('学习笔记',s.note,'含义、使用场景或我想模仿的表达',value=>{s.note=value;changed();},2);note.classList.add('compact-note');el.append(note);container.append(el);
  }
  if(!shown)container.textContent=filter==='pronunciation'?'还没有标记发音不匹配的单词。':filter==='listening'?'还没有标记“听不懂”的句子。':'没有符合筛选条件的句子。';
}

async function openWord(word,segment){
  wordContext={recordingId:current,segment,word:normalizedWord(word)};$('wordTitle').textContent=wordContext.word;$('wordIpa').textContent='正在查找离线词典…';$('wordMeta').textContent='';$('ipaSymbols').replaceChildren();$('ipaHelp').textContent='点击音标查看发音提示。';$('wordDialog').showModal();
  try{
    const result=await api('/api/pronunciation?word='+encodeURIComponent(wordContext.word));
    if(!result.found){$('wordIpa').textContent='离线词典未收录';$('wordMeta').textContent='专业缩写、专名或转写错误可能无法查询。请先核对拼写。';}
    else{
      $('wordIpa').textContent=result.ipa;$('wordMeta').textContent=`${result.syllables} 个音节 · 主重音：${result.primary_stress?`第 ${result.primary_stress} 音节`:'未标注'} · 美式词典`;
      for(const phone of result.phones){if(!phone.ipa)continue;const b=document.createElement('button');b.textContent='/'+phone.ipa+'/';b.onclick=()=>showIpaHelp(phone.ipa);$('ipaSymbols').append(b);}
    }
  }catch(e){$('wordIpa').textContent='查询失败';$('wordMeta').textContent=e.message;}
  updateMismatchButton();await loadWordRecording();
}
function showIpaHelp(symbol){const help=IPA_HELP[symbol]||['音标 /'+symbol+'/','先听系统示范，再录下自己的发音进行对比。',''];$('ipaHelp').replaceChildren();const title=document.createElement('strong');title.textContent=help[0];const text=document.createElement('p');text.textContent=help[1];const example=document.createElement('small');example.textContent=help[2]?'例词：'+help[2]:'';$('ipaHelp').append(title,text,example);}
function updateMismatchButton(){if(!wordContext)return;const marked=wordContext.segment.mismatch_words.includes(wordContext.word);$('mismatchWord').textContent=marked?'✓ 已标记 Pronunciation mismatch':'⚠ 标记 Pronunciation mismatch';$('mismatchWord').setAttribute('aria-pressed',marked);}
$('mismatchWord').onclick=()=>{if(!wordContext)return;const list=wordContext.segment.mismatch_words,index=list.indexOf(wordContext.word);if(index>=0)list.splice(index,1);else{list.push(wordContext.word);wordContext.segment.mastered=false;}changed();updateMismatchButton();};
$('wordDialog').addEventListener('close',()=>{if(mediaRecorder?.state==='recording')mediaRecorder.stop();render();});
$('speakWord').onclick=()=>{if(!wordContext||!('speechSynthesis'in window))return;window.speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(wordContext.word);utterance.lang='en-US';const voice=speechSynthesis.getVoices().find(v=>v.lang.toLowerCase()==='en-us');if(voice)utterance.voice=voice;speechSynthesis.speak(utterance);};

function recordingDb(){return new Promise((resolve,reject)=>{const request=indexedDB.open('listen-learn-recordings',1);request.onupgradeneeded=()=>request.result.createObjectStore('words');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
function recordingKey(){return `${wordContext.recordingId}:${wordContext.segment.id}:${wordContext.word}`;}
async function saveWordRecording(blob){const db=await recordingDb();await new Promise((resolve,reject)=>{const tx=db.transaction('words','readwrite');tx.objectStore('words').put(blob,recordingKey());tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();}
async function getWordRecording(){const db=await recordingDb();const blob=await new Promise((resolve,reject)=>{const tx=db.transaction('words');const request=tx.objectStore('words').get(recordingKey());request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});db.close();return blob;}
async function loadWordRecording(){try{const blob=await getWordRecording();if(recordingUrl)URL.revokeObjectURL(recordingUrl);recordingUrl=blob?URL.createObjectURL(blob):null;$('playRecording').disabled=!blob;$('recordStatus').textContent=blob?'已载入你的本地录音，可回听比较。':'录音只保存在当前浏览器，不上传。';}catch(e){$('recordStatus').textContent='无法读取本地录音：'+e.message;}}
$('recordWord').onclick=async()=>{
  if(mediaRecorder?.state==='recording'){mediaRecorder.stop();return;}
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});recordedChunks=[];mediaRecorder=new MediaRecorder(stream);mediaRecorder.ondataavailable=e=>{if(e.data.size)recordedChunks.push(e.data);};mediaRecorder.onstop=async()=>{stream.getTracks().forEach(track=>track.stop());const blob=new Blob(recordedChunks,{type:mediaRecorder.mimeType||'audio/webm'});await saveWordRecording(blob);$('recordWord').textContent='🎤 重新录音';$('recordStatus').textContent='录音已保存到当前浏览器。';await loadWordRecording();};mediaRecorder.start();$('recordWord').textContent='⏹ 停止并保存';$('recordStatus').textContent='正在录音…读完这个单词后点击停止。';
  }catch(e){$('recordStatus').textContent='无法录音：请允许浏览器使用麦克风。';}
};
$('playRecording').onclick=()=>{if(recordingUrl)new Audio(recordingUrl).play();};

$('export').onclick=()=>{
  if(!doc)return;const format=$('format').value;let content;
  if(format==='srt')content=doc.segments.map((s,i)=>`${i+1}\n${time(s.start,true)} --> ${time(s.end,true)}\n${s.text}\n`).join('\n');
  else content=(format==='md'?'# ':'')+doc.name+'\n\n'+doc.segments.map(s=>`${format==='md'?'## ':''}[${time(s.start)}] ${s.listening?'[听不懂] ':''}${s.mismatch_words.length?'[发音:'+s.mismatch_words.join(', ')+'] ':''}${s.speaking?'[不会说] ':''}${s.mastered?'[已掌握] ':''}\n${s.text}${s.meaning?'\n\n含义：'+s.meaning:''}${s.my_response?'\n\nMy Response：'+s.my_response:''}${s.note?'\n\n笔记：'+s.note:''}`).join('\n\n');
  const url=URL.createObjectURL(new Blob(['\ufeff'+content],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=doc.name.replace(/\.[^.]+$/,'')+'.'+format;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
