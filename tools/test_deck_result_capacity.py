"""Use an isolated SQLite DB and synthetic payloads only."""
import sys,importlib.util,tempfile,threading,json,urllib.request,urllib.error
from pathlib import Path
from http.server import ThreadingHTTPServer
spec=importlib.util.spec_from_file_location('api',sys.argv[1]);api=importlib.util.module_from_spec(spec);spec.loader.exec_module(api)
with tempfile.TemporaryDirectory() as temp:
 api.DB_PATH=str(Path(temp)/'test.db');api.init()
 with api.closing(api.db()) as c,c:
  for ident in ['test-a','test-b']:c.execute('INSERT INTO accounts VALUES(?,?,?,?,?,?,?)',(ident,ident,ident,'unused',None,api.now(),api.now()))
  token=api.make_token(c,'test-a');other=api.make_token(c,'test-b')
 server=ThreadingHTTPServer(('127.0.0.1',0),api.Api);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
 def call(method,path,body=None,who=token,status=200):
  req=urllib.request.Request('http://127.0.0.1:'+str(server.server_port)+path,data=json.dumps(body).encode() if body is not None else None,headers={'Authorization':'Bearer '+who,'Content-Type':'application/json'},method=method)
  try:
   with urllib.request.urlopen(req) as response:code=response.status;raw=response.read()
  except urllib.error.HTTPError as error:code=error.code;raw=error.read()
  assert code==status,(code,raw[:300]);return json.loads(raw) if raw else None
 def payload(size):return {'kind':'deck-batch','schema_version':1,'sections':[],'display':{},'padding':'x'*size}
 try:
  value=payload(700*1024);value['access_key']='SYNTHETIC-SECRET';created=call('POST','/api/results',{'title':'Synthetic batch','payload':value},status=201);path='/api/results/'+created['id']
  read=call('GET',path);assert read['payload']['padding']==value['padding'];assert 'access_key' not in read['payload']
  call('GET',path,who=other,status=404)
  newer=payload(950*1024);call('PUT',path,{'payload':newer,'version':read['version']});assert call('GET',path)['payload']==newer
  version=call('GET',path)['version'];call('PUT',path,{'payload':payload(2*1024*1024),'version':version},status=413);assert call('GET',path)['payload']==newer
  call('POST','/api/results',{'payload':payload(2*1024*1024)},status=413)
  call('POST','/api/results',{'payload':{'kind':'b25','padding':'x'*(700*1024)}},status=413)
  malformed=payload(700*1024);malformed['schema_version']=2;call('POST','/api/results',{'payload':malformed},status=413)
  print('PASS 700KB create/read, 950KB update, unchanged data after oversized rejection, 2MB cap, original limits, owner isolation and secret stripping')
 finally:server.shutdown();server.server_close();thread.join()
