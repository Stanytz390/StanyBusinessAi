import mongoose from 'mongoose';

const OwnerSchema = new mongoose.Schema({
    ownerName: { type: String, required: true },
    ownerNumber: { type: String, required: true, unique: true },
    businessName: { type: String, default: "Stany Max Hub Business" },
    welcomeMessage: { type: String, default: "Karibu kwenye kituo chetu cha huduma!" },
    services: [
        {
            keyword: { type: String, required: true },
            name: { type: String, required: true },
            description: { type: String, required: true },
            price: { type: String, required: true },
            imageUrl: { type: String, default: "" }
        }
    ]
});

export const Owner = mongoose.model('Owner', OwnerSchema);