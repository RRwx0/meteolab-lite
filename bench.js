const fs=require("fs"); const path=require("path");
global.window=global;
const src=(f)=>fs.readFileSync(path.join(__dirname,"src",f),"utf8");
eval(src("sounding.js")); eval(src("model.js"));
const S=global.ML.sounding, M=global.ML;
const p={t0:31,rh0:58,lapseLow:7.7,lapseMid:7.2,lapseTop:6.2,zTrop:11.5,rhMid:40,rhTop:20,ws0:9,ws3:16,ws6:28,ws10:38,wd0:170,veer:110,bubble:3.2};
p.wd3=170+110*0.33;p.wd6=170+110*0.66;p.wd10=280;
const prof=S.buildProfile(p);
console.log("CAPE",prof.cape.toFixed(0),"сдвиг",prof.shear06.toFixed(1),"SRH",prof.srh.toFixed(0),"LCL",(prof.lcl/1000).toFixed(2));
for (const g of [48,80,120]) {
  const m=new M.Model(prof,{nx:g,ny:g,mode:"field",count:8,heating:0.7,bubble:3.0});
  const t0=Date.now();
  for(let i=0;i<40;i++) m.step();
  const ms=(Date.now()-t0)/40;
  console.log(`сетка ${g}²: nz=${m.nz} dz=${m.dz} dt=${m.dt} sor=${m.pressureIters} | ячеек ${m.n}, мс/шаг ${ms.toFixed(1)}, sim-мин/с ${(m.dt*1000/ms/60).toFixed(1)}`);
}
