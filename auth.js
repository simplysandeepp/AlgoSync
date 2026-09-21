const { proto, BufferJSON, initAuthCreds } = require('@whiskeysockets/baileys');
const mongoose = require('mongoose');

const AuthSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    data: { type: String, required: true }
});

const AuthModel = mongoose.models.AuthState || mongoose.model('AuthState', AuthSchema);

const useMongoDBAuthState = async () => {
    const writeData = async (data, id) => {
        try {
            const stringified = JSON.stringify(data, BufferJSON.replacer);
            await AuthModel.updateOne(
                { _id: id },
                { $set: { data: stringified } },
                { upsert: true }
            );
        } catch (error) {
            console.error('Error saving data to MongoDB:', error);
        }
    };

    const readData = async (id) => {
        try {
            const doc = await AuthModel.findById(id);
            if (doc) {
                return JSON.parse(doc.data, BufferJSON.reviver);
            }
            return null;
        } catch (error) {
            console.error('Error reading auth state from MongoDB:', error);
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            await AuthModel.deleteOne({ _id: id });
        } catch (error) {
            console.error('Error removing auth state from MongoDB:', error);
        }
    };

    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                tasks.push(writeData(value, key));
                            } else {
                                tasks.push(removeData(key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => {
            return writeData(creds, 'creds');
        }
    };
};

module.exports = { useMongoDBAuthState };
