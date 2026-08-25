/** A deliberately small local-first storage boundary. */
export const storageAdapter = {
  async get(key){
    const value = localStorage.getItem('rk:' + key);
    return value === null ? null : {key, value, shared:false};
  },
  async set(key, value){
    localStorage.setItem('rk:' + key, value);
    return {key, value, shared:false};
  },
  async delete(key){
    localStorage.removeItem('rk:' + key);
    return {key, deleted:true, shared:false};
  },
};
