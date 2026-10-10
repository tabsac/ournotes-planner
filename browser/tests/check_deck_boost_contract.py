import ast,types
from pathlib import Path
tree=ast.parse((Path(__file__).resolve().parents[1]/'deck_local.py').read_text('utf-8'));nodes=[v for v in tree.body if isinstance(v,ast.FunctionDef) and v.name=='validate' or isinstance(v,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='LABELS' for t in v.targets)]
p=types.SimpleNamespace(growth_issues=lambda *a:{'complete':True});ns={'data':lambda:(p,None,None,None),'apply_growth':lambda *a:None};exec(compile(ast.Module(body=nodes,type_ignores=[]),'contract','exec'),ns)
doc={'profile':{'inventory':{'members':[{'id':i,'level':1,'training_count':0,'awakening_count':0,'live_skill_level':1,'gekisou_skill_level':1} for i in range(1,6)],'snaps':[{'id':i,'level':1,'limit_break_count':0} for i in range(1,6)]},'facilities':[],'character_ranks':[],'character_total_rank':1,'tgw_card_rank':1}}
assert ns['validate'](doc,{})[1]['boost']==3
for value in [0,1,2,3]:assert ns['validate'](doc,{'boost':value})[1]['boost']==value
for value in [-1,4,5,10,True,1.5]:
 try:ns['validate'](doc,{'boost':value})
 except ValueError:pass
 else:raise AssertionError(value)
print('PASS Boost 0/1/2/3 accepted; default 3; 4/5/10 and invalid types rejected')
