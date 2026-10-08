"""Browser transport using the same server batch adapter and game formulas."""
import copy,json,time,hashlib
from pathlib import Path
from js import browser_cancelled,browser_native_cached,browser_progress
import browser_runtime as br
p=br.p
ROOT=Path('/planner')
LABELS={'daily': '自由组卡', 'song': '歌曲组卡', 'leaderboard': '歌榜组卡', 'activity': '活动收益', 'fire': '日常 / 清火组卡', 'gekiso': '激奏组卡'}
def digest(v):return hashlib.sha256(json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
_data=None
def data():
 global _data
 if _data is None:_data=(br.p,br.data,json.loads((ROOT/'deck-data.json').read_text()),br.data.catalog())
 return _data
pending_native={}
class NeedNative(Exception):pass
class Event:
 def is_set(self):return bool(browser_cancelled())
class Native:
 def __init__(self,*args):self.cache_hits=0
 def call(self,payload):
  if browser_cancelled():raise br.p.Cancelled()
  raw=json.dumps(payload,separators=(',',':'));key=digest(payload);value=browser_native_cached(key)
  if not value:pending_native.update(key=key,raw=raw);raise NeedNative()
  answer=json.loads(str(value))
  if not answer.get('ok'):raise ValueError(answer.get('error','计分失败。'))
  self.cache_hits+=1;return answer['result']
 def close(self):pass
partial=None
def update(ident,**values):
 global partial
 if 'result' in values:partial=copy.deepcopy(values['result'])
 if 'progress' in values:browser_progress(json.dumps(values['progress'],ensure_ascii=False))
def validate(doc,raw):
 if not isinstance(doc,dict) or not isinstance(doc.get('profile'),dict):raise ValueError('请先上传并同步卡库。')
 p,d,n,cat=data();r={'schema_version':1,'name':str(doc.get('name') or '我的卡库')[:80],'profile':{}}
 profile=doc['profile'];inv=profile.get('inventory',{});r['profile']['inventory']={}
 for kind,fields in [('members',('id','level','training_count','awakening_count','live_skill_level','gekisou_skill_level')),('snaps',('id','level','limit_break_count'))]:
  values=inv.get(kind)
  if not isinstance(values,list) or len(values)>1000 or any(not isinstance(v,dict) for v in values):raise ValueError('卡库列表不完整。')
  r['profile']['inventory'][kind]=[{k:v.get(k) for k in fields} for v in values]
  key='candidate_member_ids' if kind=='members' else 'candidate_snap_ids';ids=[v.get('id') for v in values]
  r[key]=doc.get(key,ids)
  if len(ids)!=len(set(ids)) or any(type(i)!=int or i<=0 for i in ids):raise ValueError('卡牌编号重复或无效。')
  if not isinstance(r[key],list) or not r[key] or len(r[key])!=len(set(r[key])) or any(type(i)!=int or i not in ids for i in r[key]):raise ValueError('候选卡池无效。')
 for key,fields in [('facilities',('id','level')),('character_ranks',('character_id','rank'))]:
  values=profile.get(key)
  if not isinstance(values,list) or len(values)>1000:raise ValueError('请补齐玩家加成。')
  r['profile'][key]=[{k:v.get(k) for k in fields} for v in values if isinstance(v,dict)]
 for key in ('character_total_rank','tgw_card_rank'):r['profile'][key]=profile.get(key)
 if not isinstance(raw,dict):raise ValueError('计算条件格式无效。')
 opts={'goals':raw.get('goals',['daily']),'methods':raw.get('methods',['ap']),'maxLevel':raw.get('maxLevel',99),'song':str(raw.get('song') or '').strip()[:80],'boost':raw.get('boost',4),'searchSeconds':raw.get('searchSeconds',3),'candidateBudget':32}
 if not isinstance(opts['goals'],list) or not opts['goals'] or len(opts['goals'])>6 or any(g not in LABELS for g in opts['goals']):raise ValueError('组卡目标无效。')
 if not isinstance(opts['methods'],list) or not opts['methods'] or any(m not in ('ap','skip') for m in opts['methods']):raise ValueError('演出方式无效。')
 for key,lo,hi in [('maxLevel',1,99),('boost',1,10),('searchSeconds',1,30)]:
  if type(opts[key])!=int or not lo<=opts[key]<=hi:raise ValueError('计算条件无效：'+key)
 opts['goals']=sorted(set(opts['goals']));opts['methods']=sorted(set(opts['methods']))
 if 'song' in opts['goals'] and not opts['song']:raise ValueError('请填写歌曲名称。')
 r['settings']={'fixed_leader_id':doc.get('settings',{}).get('fixed_leader_id'),'normal':{'method':'ap' if 'ap' in opts['methods'] else 'skip'},'challenge':{'method':'skip'}}
 leader=r['settings']['fixed_leader_id']
 if leader is not None and (type(leader)!=int or leader not in r['candidate_member_ids']):raise ValueError('固定队长不在候选卡池中。')
 issues=p.growth_issues(r,d)
 if not issues['complete']:raise ValueError('请补齐本次所需养成：'+'；'.join(x['label'] for x in issues['issues'][:4]))
 if 'gekiso' in opts['goals'] and 'ap' in opts['methods']:
  selected=set(r['candidate_member_ids'])
  if any(type(x.get('gekisou_skill_level'))!=int or not 1<=x['gekisou_skill_level']<=5 for x in r['profile']['inventory']['members'] if x['id'] in selected):raise ValueError('请补齐候选成员的激奏技能等级。')
 return r,opts

def roster(doc):
 p=doc['profile'];m=p['inventory']['members'];s=p['inventory']['snaps']
 return {'player':{'characterRanks':{str(x['character_id']):x['rank'] for x in p['character_ranks']},'explicitCharacterTotalRank':p['character_total_rank'],'bandItems':{str(x['id']):x['level'] for x in p['facilities']},'vipRank':p['tgw_card_rank'],'ownedMemberCardIds':[x['id'] for x in m],'ownedSupportCardIds':[x['id'] for x in s]},'members':[{'id':x['id'],'level':x['level'],'awake':x['training_count']+1,'rank':x['awakening_count']+1,'liveSkillLevel':x['live_skill_level'] or 1,'gekisouSkillLevel':x['gekisou_skill_level'] or 1} for x in m if x['id'] in doc['candidate_member_ids']],'snaps':[{'id':x['id'],'level':x['level'],'rank':x['limit_break_count']+1} for x in s if x['id'] in doc['candidate_snap_ids']]}

def number(f):return None if f is None else int(f['numerator'])/int(f['denominator'])
def request(spec,method,seconds,leader=None,gekiso=False):
 return {'format':'ournotes-deck.search-request/1','execution':{'kind':'skip','scoreId':spec['scoreId']} if method=='skip' else {'kind':'live','scoreId':spec['scoreId'],'gekisou':gekiso,'play':{'kind':'theoreticalBest'}},'scenario':{'kind':'mission' if gekiso and method!='skip' else 'free','musicId':spec['song_id']},'metric':{'kind':'score'},'constraints':{'leader':leader},'k':3,'limits':{'timeLimitMs':seconds*1000,'cacheEntries':256}}

def row(deck,spec,method,proof):
 value=number(deck.get('expectedScore'));interval=deck.get('scoreInterval')
 if value is None and interval:value=number(interval['lower'])
 if value is None:raise ValueError('此技能的得分期望未能求出。')
 return {'member_ids':deck['members'],'snap_ids':deck['snaps'],'leader_member_id':deck['members'][2],'power':deck['power'],'song_id':spec['song_id'],'song_title':spec['title'],'difficulty':spec['difficulty'],'level':spec['level'],'method':method,'score':value,'summary':deck.get('scoreSummary'),'proven':proof=='proven','score_interval':interval}

def specs_for(cat,native,opts,goal):
 chart_ids={c['scoreId'] for c in native['charts']};table=native['master']['MasterLiveMusic'];music={r['_id']:r for r in (dict(zip(table['columns'],v)) for v in table['rows'])};result=[]
 for song in cat['songs']:
  if (goal=='song' or goal in ('daily','gekiso') and opts['song']) and opts['song'].casefold() not in (str(song['id']).casefold(),song['title'].casefold()):continue
  choices=[]
  for sheet in song['sheets']:
   if sheet.get('level',999)>opts['maxLevel']:continue
   score=music[song['id']].get('_'+sheet['difficulty']+'ID')
   if score in chart_ids:choices.append({'song_id':song['id'],'title':song['title'],'difficulty':sheet['difficulty'],'level':sheet['level'],'scoreId':score})
  if choices:
   if goal in ('daily','gekiso'):choices=[max(choices,key=lambda s:['easy','normal','hard','expert'].index(s['difficulty']))]
   result.extend(choices)
 if not result:raise ValueError('没有找到该歌曲或最高难度限制内可计算的谱面。')
 return result

def run(ident,body,event):
 engine=None;result={'kind':'deck-batch','schema_version':1,'name':body['document']['name'],'model':body['model'],'options':body['options'],'computedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'sections':[],'notes':[]}
 try:
  if event.is_set():raise InterruptedError('已取消')
  update(ident,status='running');p,d,n,cat=data();doc=body['document'];opts=body['options'];
  owner='browser-local'
  engine=Native(event,owner,body['model']);owned=roster(doc)
  result['display']={k:cat[k] for k in ('members','snaps','songs')};result['profile']=doc['profile']
  for goal in opts['goals']:
   if event.is_set():raise InterruptedError('已取消')
   if goal in ('activity','fire','leaderboard'):
    import activity_goals,team_options,solver_search

    entries=[];targets=['cp','event_pt','shop_pt'] if goal in ('activity','fire') else ['challenge_score','challenge_skip']
    for method in opts['methods']:
     for objective in targets:
      if goal=='leaderboard' and (objective=='challenge_skip')!=(method=='skip'):continue
      r=copy.deepcopy(doc);r['settings'].update({'goal':objective,'reward_stage':'normal','boost_per_live':opts['boost'],'challenge_cp':200});phase='challenge' if goal=='leaderboard' else 'normal';choices=specs_for(cat,n,opts,'activity')
      if phase=='challenge':
       table=n['master']['MasterChallengeMusic'];allowed={v['_liveMusicId'] for v in (dict(zip(table['columns'],x)) for x in table['rows']) if v['_eventId']==d.event['event_id']};choices=[x for x in choices if x['song_id'] in allowed]
      r['settings']['include_all_songs']=goal=='leaderboard'
      r['settings'][phase]={'method':method,'sheets':[{'song_id':x['song_id'],'difficulty':x['difficulty']} for x in choices]};r=team_options.configure(r,p,d)
      def progress(**values):
       if event.is_set():raise p.Cancelled()
       update(ident,progress={'goal':LABELS[goal],'metric':objective,'method':method,**{k:v for k,v in values.items() if k in ('stage','done','total','completed_sheets','total_sheets')}},result=result)
      cache=br.cache
      answer=activity_goals.optimize(r,p,d,progress=progress,cancelled=event.is_set,cache=cache,run_id=ident);rows=answer['recommendations']
      for v in rows:
       v['song_title']=next((song['title'] for song in cat['songs'] if song['id']==v['song_id']),str(v['song_id']))
       if goal=='fire':v['per_boost']=v['target_value']/opts['boost']
      entries.append({'metric':objective,'method':method,'rows':rows,'label':answer['goal']['label'],'unit':answer['goal']['unit'],'proven':True})
    result['sections'].append({'goal':goal,'label':LABELS[goal],'entries':entries,'notes':['收益为当前接入活动的参考公式结果。','清火按每Boost的PT推荐，并同时展示CP和徽章。'] if goal=='fire' else ['各目标分别求最优。']})
   else:
    choices=specs_for(cat,n,opts,goal)
    for method in opts['methods']:
     found=[];candidates={};frequencies={}
     for index,spec in enumerate(choices):
      q=request(spec,method,opts['searchSeconds'],doc['settings'].get('fixed_leader_id'),goal=='gekiso');out=engine.call({'roster':owned,'request':q})
      if not out['results'] and opts['searchSeconds']<30:
       update(ident,progress={'goal':LABELS[goal],'stage':'正在延长此谱面搜索至30秒','completed_sheets':index,'total_sheets':len(choices)},result=result)
       q['limits']['timeLimitMs']=30000;out=engine.call({'roster':owned,'request':q})
      rows=[row(v,spec,method,out['optimality']) for v in out['results']]
      if not rows:raise ValueError('搜索时限内没有找到队伍，可增加单谱面时限。')
      found.append((spec,rows))
      for v in rows:
       key=tuple(v['member_ids'])+tuple(v['snap_ids']);candidates.setdefault(key,v);frequencies[key]=frequencies.get(key,0)+1
      update(ident,progress={'goal':LABELS[goal],'method':method,'completed_sheets':index+1,'total_sheets':len(choices)},result=result)
     if goal=='song' or goal in ('daily','gekiso') and opts['song']:result['sections'].append({'goal':goal,'label':LABELS[goal],'method':method,'rows':([rows[0] for _,rows in found] if goal=='song' else found[0][1][:3]),'notes':['指定歌曲的最高可用难度；限时结果不宣称最优。']+(['激奏参考使用单人任务与区间首位假设，不预测多人连胜。'] if goal=='gekiso' and method=='ap' else ['Skip只比较跳过分，不触发激奏任务。'] if goal=='gekiso' else [])})
     else:
      pool=[candidates[k] for k in sorted(candidates,key=lambda k:(-frequencies[k],k))[:opts['candidateBudget']]];ranked=[]
      for idx,v in enumerate(pool):
       ratios=[];lows=[]
       for spec,best in found:
        q=request(spec,method,30,doc['settings'].get('fixed_leader_id'),goal=='gekiso');o=engine.call({'roster':owned,'request':q,'deck':{'members':v['member_ids'],'snaps':v['snap_ids']}})
        if not o['results']:raise ValueError('固定队伍评分未完成。')
        tested=row(o['results'][0],spec,method,'notApplicable');ratios.append(tested['score']/best[0]['score']);summary=tested.get('summary');lows.append((summary['p10'] if summary else tested['score'])/best[0]['score'])
       clean={k:x for k,x in v.items() if k not in ('song_id','song_title','difficulty','level','score','summary','score_interval','proven','power')};clean.update({'average_relative_score':sum(ratios)/len(ratios),'weak_relative_score':min(lows),'covered_sheets':len(found),'proven':False});ranked.append(clean)
       update(ident,progress={'goal':LABELS[goal],'method':method,'evaluated_teams':idx+1,'candidate_teams':len(pool)},result=result)
      ranked.sort(key=lambda x:(x['weak_relative_score'],x['average_relative_score']) if goal=='gekiso' else (x['average_relative_score'],x['weak_relative_score']),reverse=True)
      notes=['同一队伍在全部所选歌曲中评估，不推荐歌曲。','逐曲得分相对于本批次逐曲搜索结果归一化，再等权平均。','最多32支候选队伍，结果是候选范围内推荐，不是全局最优证明。']
      if goal=='gekiso':notes+=['参考：单人激奏任务模型包含区间首位假设，尚不能代表多人连胜；优先减少跨曲薄弱场景，不预测连胜概率。']
      result['sections'].append({'goal':goal,'label':LABELS[goal],'method':method,'rows':ranked[:3],'notes':notes})
   update(ident,result=result)
  result['display']={k:cat[k] for k in ('members','snaps','songs')};result['profile']=doc['profile'];result['cacheHits']=engine.cache_hits;update(ident,status='complete',result=result)
  return result
 except Exception:
  raise
 finally:
  if engine:engine.close()



def invoke(body,ident):
 global partial
 doc,opts=validate(body['document'],body['options'])
 try:
  result=run(ident,{'document':doc,'options':opts,'model':'browser-local:'+br.data.fingerprint()},Event())
  return {'status':'complete','result':result}
 except NeedNative:raise
 except br.browser_cp.NeedSolve:raise
 except br.p.Cancelled:return {'status':'cancelled','result':partial}
 except Exception as e:return {'status':'cancelled' if browser_cancelled() or str(e)=='已取消' else 'failed','error':str(e),'result':partial}
