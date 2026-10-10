"""Bounded native reward search; score/reward semantics remain the planner's."""
import copy,json,time,hashlib
from pathlib import Path

def snapshot(doc,event_id):
 p=doc['profile'];m=p['inventory']['members'];s=p['inventory']['snaps']
 return {'format':'ournotes.owned-snapshot/1','datasetId':hashlib.sha256(Path('/planner/deck-data.json').read_bytes()).hexdigest(),'revision':'browser-local','ownedFacts':{'memberIds':[v['id'] for v in m],'snapIds':[v['id'] for v in s],'memberCoverage':'complete','snapCoverage':'complete'},'eligible':{'members':[{'id':v['id'],'level':v['level'],'awake':v['training_count']+1,'rank':v['awakening_count']+1,'liveSkillLevel':v['live_skill_level'],'gekisouSkillLevel':v['gekisou_skill_level']} for v in m if v['id'] in doc['candidate_member_ids']],'snaps':[{'id':v['id'],'level':v['level'],'rank':v['limit_break_count']+1} for v in s if v['id'] in doc['candidate_snap_ids']]},'player':{'eventIds':[event_id],'characterRanks':{'coverage':'complete','values':[{'id':v['character_id'],'value':v['rank']} for v in p['character_ranks']]},'characterTotalRank':p['character_total_rank'],'vipRank':p['tgw_card_rank'],'bandItems':[{'id':v['id'],'value':v['level']} for v in p['facilities'] if v['level']],'memory':{'musicRanks':[],'unlockedMembers':[],'unlockedSnaps':[]}},'assumptions':[{'path':'player.memory','reason':'Matches the current planner profile transport; no memory progress is supplied'}]}

def context(event_id,method,boost,selected=None):
 ticks=621355968000000000+int((time.time()+9*3600)*10000000)
 clock={'execution':'skip' if method=='skip' else 'played','serverNowJstTicks':ticks}
 if method!='skip':clock['savedStartJstTicks']=None
 return {'powerSnapshot':{'eventIds':[event_id],'capturedJstTicks':None},'resultClock':clock,'eventPayoff':{'consumedCount':boost,'localEvents':[{'eventId':event_id,'points':0,'challengePoints':0,'added':[]}],'eventWindows':None,'eventWindowAdapter':'canonical-master-no-offset','selectedRewards':selected,'multiplayerRanks':None,'multiplayerResultPanel':None,'multiplayerScorePolicy':None}}

async def rewards(engine,doc,opts,choices,p,d,progress,cancelled,mode="normal",exchange=None):
 from activity_goals import score_row,row_key
 challenge=mode=='challenge';consumed=opts['challengeCp'] if challenge else opts['boost']
 eid=d.event['event_id'];account=json.dumps(snapshot(doc,eid),separators=(',',':'))
 model=p.PowerModel(d,doc['profile'],doc['candidate_member_ids'],doc['candidate_snap_ids'])
 event=d.index['MasterEvent'][eid]
 badge=[v for v in d.tables['MasterChallengeLiveEventReward' if challenge else 'MasterLiveEventReward'] if v['_eventGroup']==event['_challengeLiveEventRewardGroup' if challenge else '_liveEventRewardGroup'] and v['_probability']==10000]
 # This native item objective supplies candidate decks only: the selected row
 # is conditional, while final badge values below use the actual score ranks.
 badge_row=max(badge,key=lambda v:v['_resourceCount']) if badge else None
 exchange_best={(e['method'],e['metric']):max(e['rows'],key=lambda row:row['target_value']/row['consumed']) for e in exchange or [] if e['rows']}
 goals=['event_pt','shop_pt'] if challenge else ['cp','event_pt','shop_pt'];entries=[]
 table=d.tables['MasterChallengeMusic'];allowed={v['_liveMusicId']:v['_id'] for v in table if v['_eventId']==eid}
 if challenge:choices=[v for v in choices if v['song_id'] in allowed]
 if not choices:raise ValueError('本次活动没有可计算的挑战歌曲。')
 choices=sorted(choices,key=lambda v:(v['song_id'],-['easy','normal','hard','expert'].index(v['difficulty'])))
 from deck_local import roster
 owned=roster(doc)
 for method in opts['methods']:
  song_pools={}
  best={g:{} for g in goals};proven={g:True for g in goals}
  for index,spec in enumerate(choices):
   if cancelled():raise p.Cancelled()
   model.music(spec['song_id'],challenge);scorer=p.Scores(d,{**spec,'method':method},challenge)
   base={'format':'ournotes-deck.search-request/1','execution':{'kind':'skip','scoreId':spec['scoreId']} if method=='skip' else {'kind':'live','scoreId':spec['scoreId'],'gekisou':False,'play':{'kind':'theoreticalBest'}},'scenario':{'kind':'challenge' if challenge else 'free','musicId':allowed[spec['song_id']] if challenge else spec['song_id']},'constraints':{'leader':doc['settings'].get('fixed_leader_id')},'k':3,'limits':{'timeLimitMs':150 if opts['searchMode']=='fast' else opts['searchSeconds']*1000,'cacheEntries':16}}
   seeds=[];pool={}
   for goal in (goals if opts['searchMode']=='thorough' or spec['song_id'] not in song_pools else []):
    metric={'kind':'clientChallengePoints' if goal=='cp' else 'clientEventPoints','eventId':eid}
    selected=None
    if goal=='shop_pt':
     if not badge_row:raise ValueError('活动徽章奖励表未完整接入。')
     metric={'kind':'conditionalClientEventItems','eventId':eid,'resourceType':badge_row['_resourceType'],'resourceId':badge_row['_resourceId']}
     selected=[{'eventId':eid,'rewardId':badge_row['_id']}]
    query={**base,'metric':metric,'context':context(eid,method,consumed,selected)}
    # Cheap Skip incumbents give live searches a legal starting result even
    # when an AP bound cannot be proved in the short interactive time slice.
    if method=='ap' and not seeds:
     warm={**query,'limits':{'timeLimitMs':300,'cacheEntries':16},'execution':{'kind':'skip','scoreId':spec['scoreId']},'metric':{'kind':'clientEventPoints' if challenge else 'clientChallengePoints','eventId':eid},'context':context(eid,'skip',consumed)}
     answer=await engine.call({'transport':'recommend','accountJSON':account,'requestJSON':json.dumps(warm,separators=(',',':'))})
     seeds=[{'members':v['members'],'snaps':v['snaps']} for v in answer['results']]
    if seeds:query['initialDecks']=seeds
    answer=await engine.call({'transport':'recommend','accountJSON':account,'requestJSON':json.dumps(query,separators=(',',':'))})
    proven[goal]=proven[goal] and answer.get('optimality')=='proven' and goal!='shop_pt'
    if not answer['results']:
     query['limits']={'timeLimitMs':1000,'cacheEntries':16};answer=await engine.call({'transport':'recommend','accountJSON':account,'requestJSON':json.dumps(query,separators=(',',':'))})
    if not answer['results']:raise ValueError('限时搜索未找到可用队伍，请增大单谱面搜索时限。')
    for v in answer['results']:pool[tuple(v['members'])+tuple(v['snaps'])]=v
    seeds=[{'members':v['members'],'snaps':v['snaps']} for v in answer['results']]
   if opts['searchMode']=='fast':
    if pool:song_pools[spec['song_id']]=list(pool.values())
    else:
     for v in song_pools[spec['song_id']]:
      query={**base,'metric':{'kind':'score'},'context':{'powerSnapshot':{'eventIds':[eid],'capturedJstTicks':None},'resultClock':None,'eventPayoff':None}}
      answer=await engine.call({'roster':owned,'request':query,'deck':{'members':v['members'],'snaps':v['snaps']}})
      if not answer['results']:raise ValueError('固定队伍评分未完成。')
      tested=answer['results'][0];pool[tuple(tested['members'])+tuple(tested['snaps'])]=tested
    proven={g:False for g in goals}
   # Every candidate is evaluated once for all three rewards. Native min/max
   # in one rank bin prove the identical rank for all 120 AP orders.
   for v in pool.values():
    members=v['members'];snaps=v['snaps'];power=v['power'];summary=v.get('scoreSummary')
    low=summary['minimum'] if summary else None;high=summary['maximum'] if summary else None
    if low is not None and p.ms.rank_for_score(low,scorer.chart['rank_thresholds'])==p.ms.rank_for_score(high,scorer.chart['rank_thresholds']):
     rank=p.ms.rank_for_score(low,scorer.chart['rank_thresholds']);count=1 if method=='skip' else 120;fraction=v.get('expectedScore')
     if fraction is None:raise ValueError('此技能的平均得分尚未能确定。')
     average=int(fraction['numerator'])/int(fraction['denominator'])
     score={'method':method,'minimum_score':low,'maximum_score':high,'average_score':average,'median_score':summary['p50'],'rank':rank,'maximum_rank':rank,'skill_orders':count,'order_rank_counts':{rank:count},'status':'model_estimate'}
    else:
     slots=p.sk.derive_ap_skill_contract(d.snapshot,doc['profile'],members,snaps,_verified_inputs=d.skill_inputs)['slots'] if method=='ap' else None
     score=scorer.evaluate(power,slots)
    row={'member_ids':members,'snap_ids':snaps,'leader_member_id':members[2],'song_id':spec['song_id'],'song_title':spec['title'],'difficulty':spec['difficulty'],'level':spec['level'],'method':method,'power':power,'score':score,'bonuses_10000':model.bonuses(members,snaps)}
    for goal in goals:
     tested=score_row(p,d,copy.deepcopy(row),goal,mode,consumed)
     if (method,goal) in exchange_best:augment_exchange_row(tested,exchange_best[(method,goal)],goal,opts['boost'])
     tested['proven']=False if goal=='shop_pt' or (method,goal) in exchange_best else proven[goal]
     previous=best[goal].get(spec['song_id'])
     if previous is None or row_key(tested)>row_key(previous):best[goal][spec['song_id']]=tested
   progress(goal='挑战演出' if challenge else '活动收益',method=method,stage='原生限时搜索 · '+spec['title'],completed_sheets=index+1,total_sheets=len(choices))
  for goal in goals:
   rows=sorted(best[goal].values(),key=row_key,reverse=True)
   for v in rows:v['proven']=proven[goal] and (method,goal) not in exchange_best;v['per_boost']=v['target_value']/consumed if consumed else None;v['stage']=mode;v['consumed']=consumed
   entries.append({'metric':goal,'method':method,'rows':rows,'label':('挑战 ' if challenge else '')+{'cp':'挑战点数 CP','event_pt':'活动 PT','shop_pt':'活动徽章'}[goal],'unit':{'cp':'CP','event_pt':'PT','shop_pt':'徽章'}[goal],'proven':proven[goal]})
 return entries

def with_challenge_exchange(normal,challenge,opts):
 """Long-run expected payoff of a normal live plus its earned CP, not an integer-budget plan."""
 out=copy.deepcopy(normal)
 for entry in out:
  if entry['metric']=='cp':continue
  matching=[e for e in challenge if e['metric']==entry['metric'] and e['method']==entry['method']]
  if not matching or not matching[0]['rows']:raise ValueError('挑战收益尚未完成，不能省略 CP 兑换收益。')
  best=max(matching[0]['rows'],key=lambda r:r['target_value']/r['consumed'])
  for row in entry['rows']:
   augment_exchange_row(row,best,entry['metric'],opts['boost'])
  entry['rows'].sort(key=lambda r:r['target_value'],reverse=True);entry['proven']=False;entry['label']+='（含 CP 挑战收益）'
 return out

def augment_exchange_row(row,best,metric,boost):
 direct=row['per_live'][metric];converted=row['per_live']['cp']*best['target_value']/best['consumed']
 row['normal_direct']=direct;row['challenge_exchange']=converted;row['challenge_team']=copy.deepcopy(best)
 row['target_value']=direct+converted;row['target_denominator']=120;row['target_numerator']=round(row['target_value']*120);row['per_boost']=row['target_value']/boost if boost else None;row['proven']=False
