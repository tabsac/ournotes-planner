"""Single-live activity objectives; budgets only belong to the legacy cycle planner."""
import copy,itertools,math,time
from search_cache import digest
GOALS={'challenge_score':('挑战曲冲榜','分'),'challenge_skip':('挑战 Skip','分'),'cp':('刷挑战点数 CP','CP'),'event_pt':('刷活动 PT','PT'),'shop_pt':('刷活动徽章','徽章')}

def prepare(request):
 r=copy.deepcopy(request);s=r['settings'];goal=s.get('goal','budget')
 if goal=='budget':return r
 if goal not in GOALS:raise ValueError('请选择有效的组卡目标。')
 if s.get('boost_per_live') is None:s['boost_per_live']=4
 if s.get('challenge_cp') is None:s['challenge_cp']=200
 mode='challenge' if goal.startswith('challenge_') else ('normal' if goal=='cp' else s.get('reward_stage','normal'))
 if mode not in ('normal','challenge'):raise ValueError('演出类型无效。')
 if goal.startswith('challenge_'):s[mode]['method']='skip' if goal=='challenge_skip' else 'ap'
 s['challenge' if mode=='normal' else 'normal']['method']='skip'
 s['boost_budget']=0;s['starting_cp']=0
 return r

def score_row(p,data,row,goal,mode,consumed,reward_cache=None):
 counts=row['score']['order_rank_counts'];den=row['score']['skill_orders']
 preview=p.rw.preview_challenge_rewards if mode=='challenge' else p.rw.preview_normal_rewards
 def reward(rank):
  k=(mode,consumed,rank,row['bonuses_10000']['event_pt'],row['bonuses_10000']['shop_pt'])
  if reward_cache is not None and k in reward_cache:return reward_cache[k]
  value=preview(data.snapshot,rank,consumed,k[3],k[4],event_id=data.event['event_id'])['gained']
  if reward_cache is not None:
   if len(reward_cache)>10000:reward_cache.clear()
   reward_cache[k]=value
  return value
 rewards={rank:reward(rank) for rank,n in counts.items() if n}
 sums={k:sum(counts[rank]*v[k] for rank,v in rewards.items()) for k in ('event_pt','shop_pt','cp')}
 row['per_live']={k:v/den for k,v in sums.items()}
 # Score statistics use the original per-note rounding; reward expectations
 # convert EACH order's rank before averaging, never rank(mean score).
 if goal.startswith('challenge_'):
  row['target_numerator']=round(row['score']['average_score']*den)
 else:row['target_numerator']=sums[goal]
 row['target_denominator']=den;row['target_value']=row['target_numerator']/den
 return row

def row_key(row):
 return (row['target_numerator']*120//row['target_denominator'],row['power'],-row['song_id'],tuple(-i for i in row['member_ids']),tuple(-i for i in row['snap_ids']))

def optimize(request,p,data,progress=lambda **k:None,cancelled=lambda:False,cache=None,run_id=None):
 begin=time.monotonic();request=prepare(request);s=request['settings'];goal=s['goal']
 mode='challenge' if goal.startswith('challenge_') else ('normal' if goal=='cp' else s.get('reward_stage','normal'))
 consumed=p.integer(s.get('challenge_cp',200) if mode=='challenge' else s.get('boost_per_live',4),'单局消耗',1)
 if (mode=='challenge' and consumed not in (200,400,800,1600)) or (mode=='normal' and consumed>10):raise p.InputError('请选择有效的单局消耗档位。')
 profile=request['profile'];mids=p._select_ids(request,profile,'candidate_member_ids','members');sids=p._select_ids(request,profile,'candidate_snap_ids','snaps')
 issues=p.growth_issues(request,data)
 if not issues['complete']:raise p.InputError('请先补齐本次候选卡所需养成。')
 grouped={}
 for m in mids:
  if m not in data.index['MasterMemberCard']:raise p.InputError('候选成员卡未接入。')
  grouped.setdefault(data.index['MasterMemberCard'][m]['_characterID'],[]).append(m)
 if len(grouped)<5 or len(sids)<5:raise p.InputError('请勾选至少 5 位不同角色和 5 张 Snap。')
 if any(i not in data.index['MasterSupportCard'] for i in sids):raise p.InputError('候选 Snap 未接入。')
 teams=p.MemberTeams(grouped);snap_sets=p.SnapSets(sids);specs=p._song_specs(s,mode,data)
 p.check_playability(request,{mode:specs},data)
 model=p.PowerModel(data,profile,mids,sids);pair_cache={};reward_cache={};rows=[];keys=[];hits=0
 per_team=len(snap_sets)*(120 if s[mode]['method']=='ap' else 1);total=len(teams)*per_team*len(specs);done=0
 if cache:cache.checkpoint(request,job_id=run_id,status='running',keys=[],total_sheets=len(specs),completed_sheets=0)
 for sheet_idx,spec in enumerate(specs):
  if cancelled():raise p.Cancelled()
  key=digest({'single_live':1,'sheet':p._sheet_cache_key(data,profile,mids,sids,spec,mode),'goal':goal,'consumed':consumed})
  saved=cache.get(key) if cache else None
  if saved:best=saved['rows'][0];hits+=1
  else:
   part=cache.get_partial(key) if cache else None
   start=part['next_member'] if part and part['next_member']<=len(teams) else 0
   best=part['rows'][0] if start and part['rows'] else None
   committed=best;completed=start;last=time.monotonic();last_emit=0
   scorer=p.Scores(data,spec,mode=='challenge');model.music(spec['song_id'],mode=='challenge')
   def emit(force=False,**extra):
    nonlocal last_emit
    now=time.monotonic()
    if force or now-last_emit>.3:
     progress(stage=GOALS[goal][0]+' · '+str(spec['song_id']),phase='精确匹配与顺序期望',done=done+completed*per_team,total=total,done_exact=str(done+completed*per_team),total_exact=str(total),total_sheets=len(specs),completed_sheets=sheet_idx,cached_sheets=hits,total_member_teams=len(teams),completed_member_teams=completed,**extra);last_emit=now
   def checkpoint():
    if cache:
     cache.put_partial(key,{'rows':[committed] if committed else [],'next_member':completed,'visited':completed*per_team,'stats':{}})
     cache.checkpoint(request,job_id=run_id,status='running',keys=keys,total_sheets=len(specs),completed_sheets=sheet_idx,partial_key=key)
   try:
    for idx,members in enumerate(teams.iter_from(start),start):
     if cancelled():raise p.Cancelled()
     lead,vectors=model.best_leader(members);tokens=None
     if spec['method']=='ap':
      tokens={};ids={}
      for offset in range(len(sids)):
       if cancelled():raise p.Cancelled()
       binding=tuple(snap_sets.ids[(offset+j)%len(sids)] for j in range(5))
       if any((m,n) not in pair_cache for m,n in zip(members,binding)):
        try:contract=p.sk.derive_ap_skill_contract(data.snapshot,profile,list(members),list(binding),_verified_inputs=data.skill_inputs)
        except ValueError as e:raise p.InputError('当前技能尚未覆盖：'+str(e)+'。可选择跳过参考或调整候选卡。') from e
        for slot in contract['slots']:pair_cache[slot['member_id'],slot['snap_id']]={'extension_ms':slot['extension_ms'],'active_live_effects':slot['active_live_effects']}
      for m in members:
       for n in sids:
        signature=p.Scores.skill_key([pair_cache[m,n]])[0];tokens[m,n]=ids.setdefault(signature,len(ids))
     def consider(snaps):
      nonlocal best
      if cancelled():raise p.Cancelled()
      power=model.total(members,snaps,vectors)
      slots=[pair_cache[m,n] for m,n in zip(members,snaps)] if tokens is not None else None
      row=score_row(p,data,{'member_ids':list(members),'snap_ids':list(snaps),'leader_member_id':lead,'song_id':spec['song_id'],'difficulty':spec['difficulty'],'power':power,'score':scorer.evaluate(power,slots),'bonuses_10000':model.bonuses(members,snaps)},goal,mode,consumed,reward_cache)
      if best is None or row_key(row)>row_key(best):best=row
      emit()
     try:outcomes=p.matching_outcomes(model,members,sids,tokens,pulse=lambda **k:emit(),cancelled=cancelled)
     except p.MatchingOverflow:
      for snapset in snap_sets:
       for snaps in (itertools.permutations(snapset) if tokens is not None else [p.strongest_assignment(model,members,snapset)]):consider(snaps)
     else:
      for _,snaps in outcomes:consider(snaps)
     completed=idx+1;committed=best
     if time.monotonic()-last>2:checkpoint();last=time.monotonic()
     emit(True)
   except p.Cancelled:checkpoint();raise
   if best is None:raise p.InputError('本次条件下没有可用队伍。')
   if cache:cache.put(key,[best],len(teams)*per_team,proven=True);cache.drop_partial(key)
  rows.append(best);done+=len(teams)*per_team;keys.append(key)
  if cache:cache.checkpoint(request,job_id=run_id,status='running',keys=keys,total_sheets=len(specs),completed_sheets=sheet_idx+1)
  progress(stage='已完成 '+str(sheet_idx+1)+' / '+str(len(specs))+' 张谱面',phase='',done=done,total=total,total_sheets=len(specs),completed_sheets=sheet_idx+1,cached_sheets=hits)
 best_by_song={}
 for row in rows:
  if row['song_id'] not in best_by_song or row_key(row)>row_key(best_by_song[row['song_id']]):best_by_song[row['song_id']]=row
 ranked=sorted(best_by_song.values(),key=row_key,reverse=True)
 if not s.get('include_all_songs'):ranked=ranked[:3]
 return {'version':p.VERSION,'goal':{'id':goal,'label':GOALS[goal][0],'unit':GOALS[goal][1],'mode':mode,'consumed':consumed,'method':s[mode]['method']},'recommendations':ranked,'search':{'complete':True,'elapsed_seconds':round(time.monotonic()-begin,2),'cached_sheets':hits,'counts':{m:{'song_sheets':len(specs) if m==mode else 0,'evaluated_bindings':total if m==mode else 0} for m in ('normal','challenge')}},'assumptions':['单局目标，无需总预算或已有 CP。','AP 按 120 种技能顺序等概率平均；最低和最高分仅供观察波动。','奖励先按每种順序的评级计算，再求平均；当前采用已接入的活动与公式。','仅在完整候选范围搜索结束后标记最优；复杂未覆盖技能会明确停止。']}
