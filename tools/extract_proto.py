import sys,json,base64,re,os
src,out=sys.argv[1],sys.argv[2]
T=open(src,encoding='utf8').read()
L=T.split('\n')
open(out+'/head.html','w').write('\n'.join(L[:7]+L[8:97]+L[100:151]))
for i in (97,98,99): open(out+'/cfg%d.js'%i,'w').write(L[i])
m=re.search(r'window\.__ASSETS__=(\{.*?\});window\.__ORIENT__',L[151])
A=json.loads(m.group(1))
os.makedirs(out+'/assets',exist_ok=True)
for k,v in A.items():
    b=base64.b64decode(v) if not v.startswith('data:') else base64.b64decode(v.split(',',1)[1])
    magic=b[:4]
    ext='glb' if magic==b'glTF' else 'mp3' if magic[:3]==b'ID3' or magic[:2] in(b'\xff\xfb',b'\xff\xf3') else 'ogg' if magic==b'OggS' else 'wav' if magic==b'RIFF' else 'png' if magic[1:4]==b'PNG' else 'bin'
    open(out+'/assets/%s.%s'%(k,ext),'wb').write(b)
    print(k,ext,len(b),v[:30] if ext=='bin' else '')
code='\n'.join(L[152:4372])
# game code = tail of last long line
last=L[4371]
open(out+'/tail.js','w').write(last)
print('tail',len(last))
