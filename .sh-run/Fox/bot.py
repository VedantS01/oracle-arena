import os,json,time,random,urllib.request
T=os.environ["ARENA_TOKEN"];B="http://localhost:8799"
def call(p,d=None):
    r=urllib.request.Request(B+p,data=json.dumps(d).encode() if d is not None else None,headers={"Authorization":"Bearer "+T,"content-type":"application/json"})
    try: return json.load(urllib.request.urlopen(r))
    except Exception as e: return {"err":str(e)}
done=set()
while True:
    s=call("/v1/state")
    if s.get("winner"): print(s["winner"],s["winReason"]);break
    st=s.get("step") or {}
    if st.get("kind")=="action" and ("Fox"==st.get("actor") or "Fox" in (st.get("actors") or [])):
        a=st["action"];t=st.get("tiles")
        key=(s["round"],s["phase"],a)
        if a=="nominate":
            r=call("/v1/nominate",{"chancellor":random.choice(st["options"])})
        elif a=="vote":
            r=call("/v1/vote",{"ja":True})
        elif a=="legislate":
            if t is not None and len(t)==3:
                i=t.index("F") if "F" in t else 0
                r=call("/v1/legislate",{"discard":i})
            else:
                i=t.index("L") if "L" in t else 0
                r=call("/v1/legislate",{"enact":i})
        elif a=="veto": r=call("/v1/veto",{"agree":True})
        elif a=="power": r=call("/v1/power",{"target":random.choice(st["options"])})
        else: r=None
        print(a,t,r,flush=True)
    time.sleep(3)
