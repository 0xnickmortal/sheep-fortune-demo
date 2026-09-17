import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Interface,getAddress,parseEther} from 'ethers';
// Generates an unsigned deployment only. No private key or broadcast path.
const [file,outArg]=process.argv.slice(2);
if(!file){console.log('Usage: npm run vault:prepare -- deployment-config.json [output-directory]');process.exit(1);}
const input=JSON.parse(await readFile(file,'utf8'));
const address=key=>{const a=getAddress(input[key]);if(/^0x0{40}$/i.test(a))throw Error(key+' cannot be zero');return a;};
const token=address('token'),owner=address('owner'),signer=address('signer');
if(owner===signer)throw Error('Use separate administrator and server signer addresses');
if(typeof input.useTokenBurn!=='boolean')throw Error('useTokenBurn must be explicit true or false');
const withdrawalCap=parseEther(String(input.maxWithdrawal)),burnCap=parseEther(String(input.maxBurn));
if(withdrawalCap<=0n||burnCap<=0n)throw Error('Caps must be positive token amounts');
const artifact=JSON.parse(await readFile(new URL('../artifacts/SheepGameVault.sol/SheepGameVault.json',import.meta.url),'utf8'));
const args=[token,owner,signer,withdrawalCap,burnCap,input.useTokenBurn],encoded=new Interface(artifact.abi).encodeDeploy(args);
const bytecode=artifact.bytecode.object.replace(/^0x/,'');
const out=resolve(outArg||'artifacts/deployment');await mkdir(out,{recursive:true});
await writeFile(resolve(out,'unsigned-deployment.json'),JSON.stringify({chainId:56,value:'0x0',data:'0x'+bytecode+encoded.slice(2)},null,2));
await writeFile(resolve(out,'verification.json'),JSON.stringify({contract:'contracts/SheepGameVault.sol:SheepGameVault',compiler:'0.8.35',optimizer:true,runs:200,evmVersion:'cancun',constructorArgs:args.map(v=>typeof v==='bigint'?v.toString():v),encodedConstructorArgs:encoded},null,2));
console.log('Prepared unsigned deployment and verification parameters in '+out+'. Nothing was broadcast.');
