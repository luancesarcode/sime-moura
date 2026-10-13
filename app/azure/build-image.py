"""Imagem OCI local sem Docker/ACR Tasks; somente dependências JavaScript.

Uso: python azure/build-image.py --az .../az.cmd --crane .../crane.exe
 --source <allowlist produzida por package.mjs> --registry <nome> --tag <tag>
Requer npm ci já concluído no Site e ferramentas portáteis verificadas.
"""
import argparse,base64,hashlib,json,os,subprocess,tarfile
from pathlib import Path

def run(args,env=None):
    result=subprocess.run(args,env=env,capture_output=True,text=True,encoding='utf8',errors='replace')
    if result.returncode:
        raise RuntimeError('Falha na ferramenta '+Path(args[0]).name+': '+result.stderr[-2000:])
    return result.stdout.strip()

def main():
    p=argparse.ArgumentParser();p.add_argument('--az',required=True);p.add_argument('--crane',required=True);p.add_argument('--source',required=True);p.add_argument('--registry',required=True);p.add_argument('--tag',required=True);p.add_argument('--reuse-image-report');a=p.parse_args()
    source=Path(a.source).resolve();site=Path(__file__).resolve().parent.parent;modules=site/'node_modules'
    manifest=json.loads((source/'deployment-manifest.json').read_text(encoding='utf8'))
    prior=json.loads(Path(a.reuse_image_report).read_text(encoding='utf8')) if a.reuse_image_report else None
    if prior:
        currentLock=next(e for e in manifest['entries'] if e['path']=='package-lock.json')['sha256']
        oldLock=next(e for e in prior['appFiles'] if e['path']=='package-lock.json')['sha256']
        if currentLock!=oldLock or prior['nativeAddons']!=0 or prior['platform']!='linux/amd64':raise RuntimeError('Dependências/base mudaram; não reutilizar camada.')
    if list(modules.rglob('*.node')):raise RuntimeError('Dependência nativa: construir em Linux antes de publicar.')
    layer=source.parent/(source.name+'-app.tar');files=[]
    def add(t,path,name):
        if path.is_symlink():raise RuntimeError('Link inesperado no pacote.')
        info=t.gettarinfo(str(path),arcname=name);info.uid=info.gid=0;info.uname=info.gname='root';info.mode=0o644;info.mtime=0
        with path.open('rb') as f:t.addfile(info,f)
    with tarfile.open(layer,'w',format=tarfile.PAX_FORMAT) as t:
        for entry in manifest['entries']:
            path=source/entry['path'];digest=hashlib.sha256(path.read_bytes()).hexdigest()
            if digest!=entry['sha256']:raise RuntimeError('Pacote alterado após manifesto: '+entry['path'])
            add(t,path,'app/'+entry['path']);files.append(entry)
        if not prior:
            for path in sorted(modules.rglob('*')):
                if path.is_file():add(t,path,'app/node_modules/'+path.relative_to(modules).as_posix())
    credential=json.loads(run([a.az,'acr','login','--name',a.registry,'--expose-token','--output','json']))
    authdir=source.parent/'.acr-auth';authdir.mkdir(exist_ok=False);config=authdir/'config.json'
    token=base64.b64encode(('00000000-0000-0000-0000-000000000000:'+credential['accessToken']).encode()).decode()
    config.write_text(json.dumps({'auths':{credential['loginServer']:{'auth':token}}}),encoding='utf8');env={**os.environ,'DOCKER_CONFIG':str(authdir)}
    destination=credential['loginServer']+'/moura-demo:'+a.tag
    try:
        base='docker.io/library/node:24-bookworm-slim';base_digest=prior['baseDigest'] if prior else run([a.crane,'digest','--platform','linux/amd64',base],env)
        base_ref=prior['image'].split(':')[0]+'@'+prior['digest'] if prior else base.split(':')[0]+'@'+base_digest
        staging=destination+'-layer'
        run([a.crane,'append','--platform','linux/amd64','--base',base_ref,'--new_layer',str(layer),'--new_tag',staging],env)
        run([a.crane,'mutate',staging,'--cmd','node,scripts/serve.mjs','--workdir','/app','--user','1000:1000','--env','PORT=8080','--env','NODE_ENV=production','--tag',destination],env)
        digest=run([a.crane,'digest',destination],env);image_config=json.loads(run([a.crane,'config',destination],env))
        expected=image_config['config'];assert expected['Cmd']==['node','scripts/serve.mjs'] and expected['WorkingDir']=='/app' and expected['User']=='1000:1000'
        report={'image':destination,'digest':digest,'base':base,'baseDigest':base_digest,'platform':'linux/amd64','nativeAddons':0,'layerSha256':hashlib.sha256(layer.read_bytes()).hexdigest(),'runtimeConfig':expected,'appFiles':files,'construction':'crane append/mutate; sem ACR Tasks; node_modules JavaScript instalados no Windows'}
        if prior:report['reusedDependencyImage']=prior['image'].split(':')[0]+'@'+prior['digest']
        (source.parent/'image.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
        print(json.dumps({k:report[k] for k in ['image','digest','baseDigest','platform','nativeAddons']}))
    finally:
        # Exclui apenas credencial efêmera criada por esta execução; nenhum cache de login é lido.
        config.unlink(missing_ok=True);authdir.rmdir()

if __name__=='__main__':main()
