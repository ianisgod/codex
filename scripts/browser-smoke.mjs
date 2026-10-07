import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const base=process.env.GENESIS_URL||'http://127.0.0.1:5173';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const name=`Browser test ${Date.now()}`;let createdId;let branchId;

try {
 await page.goto(base);await page.getByRole('heading',{name:'A world of its own.'}).waitFor();
 assert.equal(await page.locator('.gmap-city').count(),6);
 await page.locator('.world-switch').click();await page.getByRole('button',{name:'New universe',exact:true}).click();
 await page.getByLabel('World name',{exact:true}).fill(name);await page.getByLabel('World seed').fill('browser-reproducible');
 await page.getByLabel('Anything unusual about this universe?').fill('The planet has two moons and exceptionally rare magic.');
 const createResponse=page.waitForResponse(r=>r.url().endsWith('/api/worlds')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'Let there be a world'}).click();const created=await (await createResponse).json();createdId=created.id;assert.equal(created.characters.length,30);
 await page.getByRole('heading',{name:'A world of its own.'}).waitFor();
 await page.locator('.gmap-city').first().click();await page.locator('.detail-drawer h2').waitFor();assert((await page.locator('.detail-drawer').innerText()).includes('inhabitants'));await page.getByRole('button',{name:'Close inspector'}).click();
 await page.getByRole('button',{name:'People',exact:true}).click();await page.locator('.character-card').first().click();await page.locator('.detail-drawer h2').waitFor();assert((await page.locator('.detail-drawer').innerText()).includes('What they know'));assert((await page.locator('.detail-drawer').innerText()).includes('Private thoughts'));await page.getByRole('button',{name:'Close inspector'}).click();
 await page.getByLabel('Advance time',{exact:true}).fill('47 years');await page.getByRole('button',{name:'Advance time',exact:true}).click();await page.getByRole('heading',{name:'Time advanced: 47 years',exact:true}).waitFor();
 assert((await page.locator('.advance-summary').innerText()).includes('people'));assert(await page.locator('.advance-events button').count()>0);await page.getByRole('button',{name:'Return to the world'}).click();
 const after=await (await fetch(`${base}/api/worlds/${createdId}`)).json();assert.equal(after.year,889);assert(after.events.length>created.events.length);
 await page.getByRole('button',{name:'Intervene',exact:true}).click();await page.getByLabel('Describe your intervention').fill('A plague starts in Valora with 20% fatality');await page.getByRole('button',{name:'Preview reality change'}).click();await page.getByRole('heading',{name:'Proposed reality change'}).waitFor();assert((await page.locator('.proposal-card').innerText()).includes('Valora'));await page.getByRole('button',{name:'Apply to reality'}).click();await page.locator('.modal').waitFor({state:'hidden'});
 await page.getByRole('button',{name:'World Canon',exact:true}).click();assert((await page.locator('main').innerText()).includes('plague starts in Valora'));
 await page.getByRole('button',{name:'Ask the world',exact:true}).click();await page.locator('.ask-form input').fill('Why are peasants unhappy?');await page.locator('.ask-form button').click();await page.locator('.answer-text').waitFor();assert((await page.locator('.answer-text').innerText()).length>100);await page.getByRole('button',{name:'Close dialog'}).click();
 await page.getByRole('button',{name:'Snapshots & timelines',exact:true}).click();await page.locator('.snapshot-list .btn').first().waitFor();const branchResponse=page.waitForResponse(r=>r.url().endsWith('/restore'));await page.locator('.snapshot-list .btn').first().click();const branch=await (await branchResponse).json();branchId=branch.id;assert.notEqual(branch.id,created.id);assert.equal(branch.year,889);await page.locator('.modal').waitFor({state:'hidden'});
 await page.getByRole('button',{name:'Ask the world',exact:true}).click();assert.equal(await page.locator('.answer-text').count(),0,'Changing timelines must discard the prior world query');await page.getByRole('button',{name:'Close dialog'}).click();
 await page.getByRole('button',{name:'Settings',exact:true}).click();const saveResponse=page.waitForResponse(r=>r.url().endsWith('/save'));await page.getByRole('button',{name:'Save world now'}).click();assert((await saveResponse).ok());await page.getByRole('button',{name:'Close dialog'}).click();
 const yearText=await page.locator('.date-block strong').innerText();await page.reload();await page.getByRole('heading',{name:'A world of its own.'}).waitFor();assert.equal(await page.locator('.date-block strong').innerText(),yearText);
 await page.getByRole('button',{name:'Play simulation'}).click();await page.waitForTimeout(3200);await page.getByRole('button',{name:'Pause simulation'}).click();assert.notEqual(await page.locator('.date-block strong').innerText(),yearText);
 for(const name of ['Civilizations','Factions','Religion','Technology','Economy','History','Statistics','Wars']){await page.getByRole('button',{name,exact:true}).first().click();assert(await page.locator('main h1').innerText());}
 await page.getByRole('button',{name:'World',exact:true}).click();await page.screenshot({path:'/tmp/genesis-verified-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.reload();await page.getByRole('heading',{name:'A world of its own.'}).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);await page.getByRole('button',{name:'Open navigation'}).click();await page.locator('.sidebar nav').getByRole('button',{name:'People',exact:true}).click();assert(await page.locator('.character-card').count()>0);await page.screenshot({path:'/tmp/genesis-verified-mobile.png',fullPage:true});
 assert.deepEqual(errors,[]);console.log('Browser smoke passed: world creation, geography inspection, character knowledge, 47-year skip, intervention preview/apply, canon, grounded query, checkpoint branch, reload persistence, live mode, all views, and mobile navigation.');
} finally {
 for(const id of [branchId,createdId])if(id)await fetch(`${base}/api/worlds/${id}`,{method:'DELETE'});
 await browser.close();
}
