import sys, importlib.util, tempfile, threading, json, urllib.request, urllib.error
from pathlib import Path
from http.server import ThreadingHTTPServer

spec=importlib.util.spec_from_file_location('game_api',Path(sys.argv[1]))
api=importlib.util.module_from_spec(spec);spec.loader.exec_module(api)
with tempfile.TemporaryDirectory() as temp:
 api.DB_PATH=str(Path(temp)/'accounts.db');api.init()
 server=ThreadingHTTPServer(('127.0.0.1',0),api.Api)
 threading.Thread(target=server.serve_forever,daemon=True).start()
 url='http://127.0.0.1:'+str(server.server_port)
 def call(path,method='GET',body=None,token=None,status=200):
  headers={'Content-Type':'application/json'}
  if token:headers['Authorization']='Bearer '+token
  req=urllib.request.Request(url+path,data=None if body is None else json.dumps(body).encode(),headers=headers,method=method)
  try:
   with urllib.request.urlopen(req) as r:code=r.status;raw=r.read()
  except urllib.error.HTTPError as e:code=e.code;raw=e.read()
  assert code==status,(path,code,raw)
  return json.loads(raw) if raw else None
 a=call('/api/register','POST',{'username':'test-one','password':'Synthetic-12345'},status=201)['token']
 b=call('/api/register','POST',{'username':'test-two','password':'Synthetic-12345'},status=201)['token']
 u='744532239894985508';v='744532239894985509'
 def doc(uid,name='Test'):
  return {'schema_version':1,'name':name,'account_import':{'account_id_text':uid},'profile':{'inventory':{'members':[],'snaps':[]}}}
 call('/api/game-accounts','POST',{'document':doc(u)},a)
 call('/api/game-accounts','POST',{'document':doc(u,'Updated')},a)
 assert len(call('/api/game-accounts',token=a))==1
 call('/api/game-accounts','POST',{'document':doc(v)},a)
 rows=call('/api/game-accounts','PUT',{'order':[v,u]},a);assert [r['uid'] for r in rows]==[v,u]
 call('/api/game-accounts','PUT',{'order':[u]},a,status=409)
 assert call('/api/game-accounts',token=b)==[]
 call('/api/game-accounts/'+u,'DELETE',token=b,status=404)
 results=[]
 for uid,kind in [(u,'profile'),(u,'b25'),(u,'deck-batch'),(v,'profile')]:
  results.append(call('/api/results','POST',{'title':'个人卡库' if kind=='profile' else kind,'payload':{'kind':kind,'gameUid':uid,'document':doc(uid),'access_token':'should-be-removed'}},a,status=201))
 assert call('/api/results',token=a)[0]['gameUid'] in [u,v]
 call('/api/results','POST',{'payload':{'accountId':u,'entries':[{'song_id':1}]}},a,status=201)
 deleted=call('/api/game-accounts/'+u,'DELETE',token=a);assert deleted['deleted']==4
 assert len(call('/api/results',token=a))==1
 assert [r['uid'] for r in call('/api/game-accounts',token=a)]==[v]
 call('/api/results','POST',{'payload':{'gameUid':u,'kind':'profile','document':doc(u)}},a,status=409)
 call('/api/game-accounts','POST',{'document':doc(u)},a)
 call('/api/results','POST',{'payload':{'gameUid':u,'kind':'profile','document':doc(u)}},a,status=201)
 call('/api/game-accounts','POST',{'document':{}},a,status=422)
 # Existing package libraries become accounts on the next listing.
 legacy='737877'
 call('/api/results','POST',{'payload':{'kind':'profile','document':doc(legacy)}},b,status=201)
 assert call('/api/game-accounts',token=b)[0]['uid']==legacy
 server.shutdown();server.server_close()
print('PASS: UID precision, import dedup, order conflicts, ownership, cascade, tombstone, re-import, legacy migration and secret stripping')
