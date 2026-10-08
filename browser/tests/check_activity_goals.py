from pathlib import Path
import sys,copy,itertools,json
h=Path(__file__).resolve().parents[1];output=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else Path.cwd()/'test-output/activity-goals';output.mkdir(parents=True,exist_ok=True);sys.path.insert(0,str(h/'tests'))
from baseline import load_baseline
p=load_baseline(output/'test-oracle');sys.path.insert(0,str(h))
import team_options,solver_search,activity_goals as ag
team_options.install(p,solver_search);d=p.Data();base=p.demo_profile()
for mode in ('normal','challenge'):base['settings'][mode]['sheets']=[{'song_id':100109,'difficulty':'expert'}]
base['settings'].update(fixed_leader_id=11,boost_budget=None,starting_cp=None)
reports=[]
for goal in ag.GOALS:
 req=copy.deepcopy(base);req['settings']['goal']=goal
 r=team_options.configure(req,p,d);out=ag.optimize(r,p,d);row=out['recommendations'][0];g=out['goal'];mode=g['mode']
 assert out['search']['complete'] and row['leader_member_id']==11
 model=p.PowerModel(d,r['profile'],req['candidate_member_ids'],req['candidate_snap_ids']);model.music(100109,mode=='challenge');lead,vectors=model.best_leader(req['candidate_member_ids'])
 spec={'song_id':100109,'difficulty':'expert','method':g['method']};sc=p.Scores(d,spec,mode=='challenge');best=None
 for snaps in itertools.permutations(req['candidate_snap_ids']):
  power=model.total(req['candidate_member_ids'],snaps,vectors);bonus=model.bonuses(req['candidate_member_ids'],snaps)
  slots=p.sk.derive_ap_skill_contract(d.snapshot,req['profile'],req['candidate_member_ids'],list(snaps),_verified_inputs=d.skill_inputs)['slots'] if g['method']=='ap' else None
  score=sc.evaluate(power,slots)
  if goal.startswith('challenge_'):value=score['average_score']
  else:
   preview=p.rw.preview_normal_rewards if mode=='normal' else p.rw.preview_challenge_rewards
   value=sum(n*preview(d.snapshot,rank,g['consumed'],bonus['event_pt'],bonus['shop_pt'])['gained'][goal] for rank,n in score['order_rank_counts'].items() if n)/score['skill_orders']
  key=(value,power)
  if best is None or key>best:best=key
 assert (row['target_value'],row['power'])==best,(goal,best,row['target_value'],row['power'])
 reports.append({'goal':goal,'value':row['target_value'],'power':row['power']})
 (output/(goal+'-result.json')).write_text(json.dumps({'actual_inputs':req,'result':out,'display':d.catalog()},ensure_ascii=False),encoding='utf-8')
 print('PASS',goal,'without budget, exhaustive 120 bindings match',row['target_value'],flush=True)
# Average rewards must not be selected from a single rank of the mean score.
synthetic={'score':{'order_rank_counts':{'C':60,'B':60},'skill_orders':120,'average_score':1},'bonuses_10000':{'event_pt':0,'shop_pt':0}}
res=ag.score_row(p,d,synthetic,'cp','normal',4)
c=p.rw.preview_normal_rewards(d.snapshot,'C',4,0,0)['gained']['cp'];b=p.rw.preview_normal_rewards(d.snapshot,'B',4,0,0)['gained']['cp']
assert res['target_value']==(c+b)/2
from search_cache import SearchCache
cache=SearchCache(Path(__import__('tempfile').mkdtemp(prefix='cache-test-',dir=output)));req=copy.deepcopy(base);req['settings']['goal']='challenge_skip';r=team_options.configure(req,p,d)
a=ag.optimize(r,p,d,cache=cache,run_id='test');b=ag.optimize(r,p,d,cache=cache,run_id='test2');assert b['search']['cached_sheets']==1 and a['recommendations']==b['recommendations']
req['settings']['goal']='challenge_score';r=team_options.configure(req,p,d);c=ag.optimize(r,p,d,cache=cache,run_id='test3');assert c['search']['cached_sheets']==0
print('PASS reward threshold weighting and goal-specific cache isolation')
(output/'native-report.json').write_text(json.dumps({'passed':True,'goals':reports},indent=2),encoding='utf-8')
