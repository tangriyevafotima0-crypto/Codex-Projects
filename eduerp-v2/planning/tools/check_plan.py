#!/usr/bin/env python3
"""Validate planning artifacts only. Does not test or deploy EduERP."""
from pathlib import Path
import argparse,csv,io,json,re,sys
ROOT=Path(__file__).resolve().parents[1]
ALLOWED={'NOT_STARTED','IN_PROGRESS','IN_REVIEW','APPROVED','BLOCKED','CHANGES_REQUIRED','STALE'}
def validate(root,doc):
 errors=[]; steps=doc.get('steps',[]); ids=[s.get('id') for s in steps]
 expected=[f'{s:02}.{j:02}' for s in range(1,25) for j in range(1,6)]
 if ids!=expected:errors.append('Step IDs/order must be exactly 01.01..24.05')
 lookup={s.get('id'):s for s in steps}
 for i,s in enumerate(steps):
  sid=s.get('id');want=[ids[i-1]] if i else []
  if s.get('depends_on')!=want:errors.append(f'{sid}: sequential dependency mismatch')
  if s.get('status') not in ALLOWED:errors.append(f'{sid}: invalid status')
  for key in ('prompt','acceptance','test_id','targets'):
   if not s.get(key):errors.append(f'{sid}: missing {key}')
  if s.get('prompt') and not (root/s['prompt']).is_file():errors.append(f'{sid}: prompt missing')
  if s.get('status') in {'IN_PROGRESS','IN_REVIEW','APPROVED'}:
   for dep in s.get('depends_on',[]):
    if lookup.get(dep,{}).get('status')!='APPROVED':errors.append(f'{sid}: prerequisite {dep} not APPROVED')
  if s.get('status')=='APPROVED':
   ev=s.get('evidence')
   if not ev or not (root/ev).is_file():errors.append(f'{sid}: approval evidence file missing')
   if not s.get('reviewed_revision'):errors.append(f'{sid}: reviewed revision missing')
   if s.get('review_result')!='PASS' or not s.get('reviewer'):errors.append(f'{sid}: review result/reviewer missing')
   if ev and not (root/ev).resolve().is_relative_to(root.resolve()):errors.append(f'{sid}: evidence must be inside planning package')
  for inp in s.get('technical_inputs',[]):
   if not inp.isdigit() or not 0<int(inp)<int(s['stage']):errors.append(f'{sid}: invalid/future technical input {inp}')
 for f in root.rglob('*.md'):
  for link in re.findall(r'\]\(([^)]+)\)',f.read_text(encoding='utf-8')):
   if link.startswith(('https://','http://','#','mailto:')):continue
   if not (f.parent/link.split('#')[0]).exists():errors.append(f'{f.relative_to(root)}: broken link {link}')
 if len(list((root/'prompts').rglob('*.md')))!=124:errors.append('Expected 124 prompts')
 if len(list((root/'stages').glob('*.md')))!=24:errors.append('Expected 24 stages')
 with (root/'requirements.csv').open() as f:req=list(csv.DictReader(f))
 work=[s for s in steps if s.get('kind')!='REVIEW']
 if len(req)!=96 or {r['owner_step'] for r in req}!={s['id'] for s in work}:errors.append('Requirement owner coverage mismatch')
 for row in req:
  s=lookup.get(row['owner_step'],{})
  if row['test_id']!=s.get('test_id'):errors.append('Requirement test ID mismatch '+row['owner_step'])
 return errors

def sync(root,doc):
 b=io.StringIO();w=csv.writer(b);w.writerow(['step_id','stage','task','targets','depends_on','status','evidence','reviewed_revision'])
 for s in doc['steps']:w.writerow([s['id'],s['stage'],s['title'],';'.join(s['targets']),';'.join(s['depends_on']),s['status'],s['evidence'] or '',s['reviewed_revision'] or ''])
 (root/'TRACKER.csv').write_text(b.getvalue(),encoding='utf-8')
 nxt=next((s for s in doc['steps'] if s['status']!='APPROVED'),None)
 approved=[s['id'] for s in doc['steps'] if s['status']=='APPROVED']
 text='# CURRENT — execution.jsondan hosil qilingan\n\nPlan: '+doc['plan_version']+'\nOxirgi approved: '+(approved[-1] if approved else 'yo‘q')+'\nNavbatdagi step: '+(nxt['id'] if nxt else 'hammasi tasdiqlangan')+'\nStatus: '+(nxt['status'] if nxt else 'APPROVED')+'\n\nImplementatsiya ruxsati shu fayldan emas, foydalanuvchi sessiyasidan aniqlanadi.\n'
 (root/'state/CURRENT.md').write_text(text,encoding='utf-8')

def invalidate(doc,sid):
 ids=[s['id'] for s in doc['steps']]
 if sid not in ids:raise ValueError('Unknown step '+sid)
 for s in doc['steps'][ids.index(sid):]:
  if s['status']!='NOT_STARTED':s['status']='STALE'

def main():
 p=argparse.ArgumentParser();p.add_argument('--sync',action='store_true');p.add_argument('--invalidate');a=p.parse_args()
 doc=json.loads((ROOT/'execution.json').read_text())
 if a.invalidate:invalidate(doc,a.invalidate)
 errors=validate(ROOT,doc)
 if errors:
  print('\n'.join('ERROR: '+e for e in errors));return 1
 if a.invalidate:(ROOT/'execution.json').write_text(json.dumps(doc,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
 if a.sync or a.invalidate:sync(ROOT,doc)
 print('PASS: plan structure, links, statuses and requirement ownership; NOT an ERP runtime test.');return 0
if __name__=='__main__':sys.exit(main())
