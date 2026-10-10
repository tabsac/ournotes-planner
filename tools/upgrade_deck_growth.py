"""Apply the website growth assumptions to the existing server song adapter."""
from pathlib import Path
import ast,shutil,time,argparse
parser=argparse.ArgumentParser();parser.add_argument('target',type=Path);a=parser.parse_args()
source=(Path(__file__).resolve().parents[1]/'browser/deck_local.py').read_text('utf-8');tree=ast.parse(source)
node=next(v for v in tree.body if isinstance(v,ast.FunctionDef) and v.name=='apply_growth');growth=ast.get_source_segment(source,node)+'\n\n'
s=a.target.read_text('utf-8')
if "'growthMode':raw.get('growthMode'" not in s:
 s=s.replace("'candidateBudget':32","'growthMode':raw.get('growthMode','current-max'),'candidateBudget':32")
 s=s.replace(" opts['goals']=sorted"," if opts['growthMode'] not in ('current-max','full-training'):raise ValueError('养成假设无效。')\n apply_growth(r,d,opts['growthMode'])\n opts['goals']=sorted")
 s=s.replace('def validate(doc,raw):',growth+'def validate(doc,raw):')
s=s.replace("raw.get('boost',4)","raw.get('boost',3)").replace("('boost',1,10)","('boost',0,3)");compile(s,str(a.target),'exec')
backup=a.target.with_name(a.target.name+'.growth-'+time.strftime('%Y%m%dT%H%M%S'));shutil.copy2(a.target,backup);a.target.write_text(s,encoding='utf-8');print('Updated; backup:',backup)
