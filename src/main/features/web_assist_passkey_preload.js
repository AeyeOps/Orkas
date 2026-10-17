// Google-only phone passkey adapter. This exposes no general application IPC.
const {contextBridge,ipcRenderer}=require('electron');
if (process.platform === 'darwin' && process.isMainFrame && location.origin === 'https://accounts.google.com') {
  contextBridge.exposeInMainWorld('__orkasPhonePasskey', {
    get: value => ipcRenderer.invoke('web-assist-passkey:get', value),
    cancel: id => ipcRenderer.send('web-assist-passkey:cancel', id),
  });
  contextBridge.executeInMainWorld({func: () => {
    if (location.protocol !== 'https:' || location.hostname !== 'accounts.google.com') return;
    const original=CredentialsContainer.prototype.get;
    const container=navigator.credentials;
    const encode=value=>{
      if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) throw new TypeError('Expected a buffer');
      const bytes=value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
      if (bytes.length > 8192) throw new TypeError('Credential request is too large');
      return btoa(Array.from(bytes,x=>String.fromCharCode(x)).join('')).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
    };
    const decode=value=>Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0)).buffer;
    CredentialsContainer.prototype.get=async function(options) {
      if (this !== container || !options?.publicKey || options.mediation==='conditional' || (options.publicKey.extensions && Object.keys(options.publicKey.extensions).length)) return original.call(this, options);
      if (options.signal?.aborted) throw new DOMException('Cancelled','AbortError');
      const p=options.publicKey;
      const dto={challenge:encode(p.challenge),rpId:p.rpId || location.hostname,timeout:p.timeout,userVerification:p.userVerification||'preferred',allowCredentials:(p.allowCredentials||[]).map(c=>({type:c.type,id:encode(c.id),transports:c.transports||[]}))};
      const id=crypto.randomUUID();
      const cancel=()=>(/** @type {any} */ (window)).__orkasPhonePasskey.cancel(id);
      options.signal?.addEventListener('abort',cancel,{once:true});
      try {
        const result=await (/** @type {any} */ (window)).__orkasPhonePasskey.get({id,publicKey:dto});
        if (options.signal?.aborted) throw new DOMException('Cancelled','AbortError');
        if (!result.ok) throw new DOMException('Phone authentication did not complete',result.code||'NotAllowedError');
        const c=result.credential;
        const response=Object.create(AuthenticatorAssertionResponse.prototype);
        for (const key of ['authenticatorData','clientDataJSON','signature','userHandle']) Object.defineProperty(response,key,{value:c.response[key] ? decode(c.response[key]) : null,enumerable:true});
        const extensions=Object.fromEntries(Object.entries(c.extensions||{}).filter(([,value])=>value!==null && value!==undefined));
        const responseJSON=()=>({authenticatorData:c.response.authenticatorData,clientDataJSON:c.response.clientDataJSON,signature:c.response.signature,...(c.response.userHandle?{userHandle:c.response.userHandle}:{})});
        Object.defineProperty(response,'toJSON',{value:responseJSON});
        const cred=Object.create(PublicKeyCredential.prototype);
        Object.defineProperties(cred,{id:{value:c.id,enumerable:true},type:{value:'public-key',enumerable:true},rawId:{value:decode(c.rawId),enumerable:true},response:{value:response,enumerable:true},authenticatorAttachment:{value:'cross-platform',enumerable:true},getClientExtensionResults:{value:()=>structuredClone(extensions)},toJSON:{value:()=>({id:c.id,rawId:c.rawId,type:'public-key',authenticatorAttachment:'cross-platform',response:responseJSON(),clientExtensionResults:structuredClone(extensions)})}});
        return cred;
      } finally { options.signal?.removeEventListener('abort',cancel); }
    };
  }});
}
